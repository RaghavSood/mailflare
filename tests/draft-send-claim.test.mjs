import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The claim that lets exactly one request send a draft, against a real SQLite
 * database with the repository's migrations (through the self-hosted
 * runtime's D1 wrapper), and the v2 send path built on it. The send binding
 * and the R2 bucket are plain objects standing in for bindings.
 */
const cacheDir = join(root, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "mailflare-draft-claim-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { users, domains, mailboxes, messages } from "./src/db/schema/index.ts";
			export { claimDraftForSend, releaseDraftClaim } from "./src/lib/email/draft-claim.ts";
			export { DRAFT_SEND_CLAIM_TTL_MS, staleClaimCutoff, refusedClaimOutcome } from "./src/lib/email/draft-claim-utils.ts";
			export { sendCompose } from "./src/lib/v2/data/compose.ts";
			export { DraftGoneError, DraftSendingError } from "./src/lib/v2/data/compose-utils.ts";
			export { eq } from "drizzle-orm";
		`,
		resolveDir: root,
		sourcefile: "draft-claim-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3"],
	// next/server comes along through the send path, and its bundled CommonJS reads __dirname.
	banner: { js: `import { fileURLToPath as __toPath } from "node:url"; const __dirname = __toPath(new URL(".", import.meta.url));` },
	logLevel: "silent",
});

const m = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

let database;
let db;
let sequence = 0;

before(async () => {
	database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, join(root, "drizzle", "migrations"));
	db = m.createDb(database);
	for (const id of ["usr_a", "usr_b"]) {
		await db.insert(m.users).values({ id, email: `${id}@example.test`, passwordHash: "x", name: id });
	}
	await db.insert(m.domains).values({ id: "dom_1", userId: "usr_a", hostname: "example.test", zoneId: "zone_1", sendingEnabled: true });
	await db.insert(m.mailboxes).values({ id: "mbx_1", userId: "usr_a", domainId: "dom_1", localPart: "a" });
});

beforeEach(async () => {
	await db.delete(m.messages);
});

/** A saved draft of usr_a, as the composer leaves it. */
async function draft(values = {}) {
	const id = `msg_draft_${++sequence}`;
	await db.insert(m.messages).values({
		id,
		userId: "usr_a",
		mailboxId: "mbx_1",
		direction: "outbound",
		status: "draft",
		read: true,
		fromAddr: "a@example.test",
		toAddr: "someone@example.org",
		subject: `Draft ${sequence}`,
		htmlBody: "<p>Hello</p>",
		...values,
	});
	return id;
}

async function row(id) {
	const [found] = await db.select().from(m.messages).where(m.eq(m.messages.id, id));
	return found ?? null;
}

async function outbound() {
	return (await db.select().from(m.messages)).filter((item) => item.status !== "draft");
}

/** A send binding whose sends finish only when the test says so, or fail. */
function sendBinding({ fail = false } = {}) {
	const sent = [];
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	let held = true;
	return {
		sent,
		open() { held = false; release(); },
		binding: {
			async send(message) {
				if (held) await gate;
				if (fail) throw new Error("Sending is unavailable");
				sent.push(message);
				return { messageId: `<sent-${sent.length}@example.test>` };
			},
		},
	};
}

function envWith(email) {
	return {
		DB: database,
		EMAIL: email,
		BUCKET: { async get() { return null; }, async put() {}, async delete() {}, async list() { return { objects: [], truncated: false }; } },
	};
}

const SESSION = { id: "usr_a", email: "usr_a@example.test", name: "usr_a", role: "user" };

function composeInput(draftId) {
	return {
		draftId,
		mailboxId: "mbx_1",
		from: "a@example.test",
		to: "someone@example.org",
		cc: "",
		bcc: "",
		subject: "Hello",
		bodyHtml: "<p>Hello</p>",
		inReplyTo: null,
		references: null,
		threadId: null,
		uploads: [],
	};
}

test("migration 0037 adds a nullable send_claimed_at that no messages trigger watches", async () => {
	const { results: columns } = await database.prepare("PRAGMA table_info(messages)").all();
	const column = columns.find((item) => item.name === "send_claimed_at");
	assert.ok(column, "column exists");
	assert.equal(column.notnull, 0);
	// Claiming must not touch Drafts, search, conversation views or the JMAP change log.
	const { results: triggers } = await database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'messages'").all();
	assert.ok(triggers.length > 0);
	for (const trigger of triggers) assert.doesNotMatch(trigger.sql, /send_claimed_at/, trigger.name);
	for (const trigger of triggers.filter((item) => /AFTER UPDATE/i.test(item.sql))) {
		assert.match(trigger.sql, /AFTER UPDATE OF /i, `${trigger.name} fires only for listed columns`);
	}
});

test("refused claims say why: still a draft means another send holds it", () => {
	assert.equal(m.refusedClaimOutcome(true), "sending");
	assert.equal(m.refusedClaimOutcome(false), "gone");
	const now = new Date("2026-10-14T12:00:00Z");
	assert.equal(now.getTime() - m.staleClaimCutoff(now).getTime(), m.DRAFT_SEND_CLAIM_TTL_MS);
	assert.ok(m.DRAFT_SEND_CLAIM_TTL_MS >= 60_000, "far longer than a send takes");
});

test("of two claims on one draft exactly one wins, and the draft stays in Drafts", async () => {
	const id = await draft();
	const claims = await Promise.all([m.claimDraftForSend(db, "usr_a", id), m.claimDraftForSend(db, "usr_a", id)]);
	assert.deepEqual(claims.map((claim) => claim.outcome).sort(), ["claimed", "sending"]);
	const winner = claims.find((claim) => claim.outcome === "claimed");
	assert.equal(winner.draft.id, id);
	assert.equal(winner.draft.htmlBody, "<p>Hello</p>");
	const stored = await row(id);
	assert.equal(stored.status, "draft");
	assert.ok(stored.sendClaimedAt instanceof Date);
});

test("a released claim can be taken again; releasing someone else's claim does nothing", async () => {
	const id = await draft();
	const first = await m.claimDraftForSend(db, "usr_a", id, new Date("2026-10-14T12:00:00Z"));
	assert.equal(first.outcome, "claimed");
	await m.releaseDraftClaim(db, id, new Date("2026-10-14T11:00:00Z"));
	assert.equal((await m.claimDraftForSend(db, "usr_a", id, new Date("2026-10-14T12:00:01Z"))).outcome, "sending");
	await m.releaseDraftClaim(db, id, first.claimedAt);
	assert.equal((await row(id)).sendClaimedAt, null);
	assert.equal((await m.claimDraftForSend(db, "usr_a", id, new Date("2026-10-14T12:00:02Z"))).outcome, "claimed");
});

test("a claim left by a send that died is taken over once it is stale, not before", async () => {
	const id = await draft();
	const start = new Date("2026-10-14T12:00:00Z");
	assert.equal((await m.claimDraftForSend(db, "usr_a", id, start)).outcome, "claimed");
	const almost = new Date(start.getTime() + m.DRAFT_SEND_CLAIM_TTL_MS - 1000);
	assert.equal((await m.claimDraftForSend(db, "usr_a", id, almost)).outcome, "sending");
	const later = new Date(start.getTime() + m.DRAFT_SEND_CLAIM_TTL_MS + 1000);
	assert.equal((await m.claimDraftForSend(db, "usr_a", id, later)).outcome, "claimed");
});

test("only the owner's drafts can be claimed; anything else is gone", async () => {
	const id = await draft();
	assert.equal((await m.claimDraftForSend(db, "usr_b", id)).outcome, "gone");
	const sent = await draft({ status: "sent" });
	assert.equal((await m.claimDraftForSend(db, "usr_a", sent)).outcome, "gone");
	assert.equal((await m.claimDraftForSend(db, "usr_a", "msg_missing")).outcome, "gone");
	assert.equal((await row(id)).sendClaimedAt, null, "a refused claim leaves the row alone");
});

test("two concurrent v2 sends of one draft deliver it once; the other is refused", async () => {
	const id = await draft();
	const email = sendBinding();
	const env = envWith(email.binding);
	// Both requests are in flight together; the send binding holds the winner until both have started.
	const both = Promise.allSettled([m.sendCompose(env, SESSION, composeInput(id)), m.sendCompose(env, SESSION, composeInput(id))]);
	await new Promise((resolve) => setTimeout(resolve, 20));
	email.open();
	const [first, second] = await both;
	const refused = [first, second].filter((result) => result.status === "rejected");
	assert.equal(refused.length, 1, "exactly one request sends");
	assert.ok(refused[0].reason instanceof m.DraftSendingError, String(refused[0].reason));
	assert.equal(email.sent.length, 1);
	assert.equal(await row(id), null, "the draft is gone once sent");
	const rows = await outbound();
	assert.deepEqual(rows.map((item) => item.status), ["sent"]);
	// A replay after the response was lost finds the draft gone.
	await assert.rejects(m.sendCompose(env, SESSION, composeInput(id)), m.DraftGoneError);
	assert.equal(email.sent.length, 1);
});

test("a failed send gives the draft back, still in Drafts, and the next try sends it", async () => {
	const id = await draft();
	const failing = sendBinding({ fail: true });
	failing.open();
	await assert.rejects(m.sendCompose(envWith(failing.binding), SESSION, composeInput(id)), /Sending is unavailable/);
	const kept = await row(id);
	assert.equal(kept.status, "draft");
	assert.equal(kept.sendClaimedAt, null);
	const working = sendBinding();
	working.open();
	await m.sendCompose(envWith(working.binding), SESSION, composeInput(id));
	assert.equal(working.sent.length, 1);
	assert.equal(await row(id), null);
});
