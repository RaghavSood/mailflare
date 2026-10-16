import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The JMAP /changes methods answer from a trigger-maintained change log, so
 * they are exercised against a real SQLite database: the repository's own
 * migrations applied through the self-hosted runtime's D1-compatible wrapper,
 * which is the same path the Node server takes at start. No Workers binding
 * is involved; the database lives in memory.
 */
// The bundle keeps better-sqlite3 (a native module) external, so it is written
// under node_modules where Node can resolve that package from it.
const cacheDir = join(root, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "mailflare-jmap-changes-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { users, domains, mailboxes, folders, messages, jmapChangeLog } from "./src/db/schema/index.ts";
			export { processRequest, validateRequest } from "./src/lib/jmap/processor.ts";
			export { getEmailState, getMailboxState } from "./src/lib/jmap/state.ts";
			export { memoize, forgetMemo } from "./src/lib/jmap/context-utils.ts";
			export { listAccessibleMailboxIdSet } from "./src/lib/jmap/access.ts";
			export { pruneChangeLog, resetPruneTimer, loadChangeRows } from "./src/lib/jmap/changes.ts";
			export { sessionState } from "./src/lib/jmap/processor.ts";
			export { classifyChanges, takeChangeWindow, diffQueryResults, parseSeqState } from "./src/lib/jmap/changes-utils.ts";
			export { encodeMailboxRef } from "./src/lib/jmap/ids.ts";
			export { eq, sql } from "drizzle-orm";
		`,
		resolveDir: root,
		sourcefile: "jmap-changes-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3"],
	logLevel: "silent",
});

const m = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const USER = { id: "usr_test", email: "me@example.test", role: "user" };
const MAILBOX = "mbx_test";
const INBOX = m.encodeMailboxRef({ kind: "role", mailboxId: MAILBOX, role: "inbox" });

let database;
let db;
let messageCounter = 0;

/** One context per request, as the handler builds it; state memoized on it must not outlive the call. */
function newContext() {
	return {
		env: { DB: database },
		db,
		auth: { userId: USER.id, email: USER.email, scopes: ["jmap"], user: USER },
		accountId: USER.id,
		origin: "http://localhost",
		createdIds: {},
	};
}

before(async () => {
	database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, join(root, "drizzle", "migrations"));
	db = m.createDb(database);
	await db.insert(m.users).values({ id: USER.id, email: USER.email, passwordHash: "x", name: "Test" });
	await db.insert(m.domains).values({ id: "dom_test", userId: USER.id, hostname: "example.test", zoneId: "zone", status: "active" });
	await db.insert(m.mailboxes).values({ id: MAILBOX, userId: USER.id, domainId: "dom_test", localPart: "me" });
});

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

/** One request holding every call, in order; each result is spread with the response name. */
async function callAll(calls) {
	const methodCalls = calls.map(([name, args], index) => [name, { accountId: USER.id, ...args }, `c${index + 1}`]);
	const response = await m.processRequest(newContext(), m.validateRequest({ using: USING, methodCalls }));
	return response.methodResponses.map(([responseName, result]) => ({ name: responseName, ...result }));
}

async function call(name, args) {
	const [result] = await callAll([[name, args]]);
	return result;
}

/** SQL of every statement the database prepares while `run` executes. */
async function recordStatements(run) {
	const prepared = [];
	const original = database.prepare;
	database.prepare = (sql) => {
		prepared.push(sql);
		return original.call(database, sql);
	};
	try {
		await run();
	} finally {
		database.prepare = original;
	}
	return prepared;
}

async function insertMessage(overrides = {}) {
	messageCounter += 1;
	const id = `msg_${messageCounter}`;
	await db.insert(m.messages).values({
		id,
		userId: USER.id,
		mailboxId: MAILBOX,
		direction: "inbound",
		fromAddr: "sender@example.org",
		toAddr: "me@example.test",
		subject: `Message ${messageCounter}`,
		status: "received",
		createdAt: new Date(1_700_000_000_000 + messageCounter * 60_000),
		...overrides,
	});
	return id;
}

test("states start at zero and a client at the current state gets an empty change set", async () => {
	assert.equal(await m.getEmailState(newContext()), "0");
	const changes = await call("Email/changes", { sinceState: "0" });
	assert.equal(changes.name, "Email/changes");
	assert.deepEqual([changes.created, changes.updated, changes.destroyed, changes.hasMoreChanges], [[], [], [], false]);
	assert.equal(changes.newState, "0");
});

test("a delivered message is reported as created, then updated, then destroyed", async () => {
	const before = await m.getEmailState(newContext());
	const id = await insertMessage();
	const created = await call("Email/changes", { sinceState: before });
	assert.deepEqual(created.created, [id]);
	assert.deepEqual(created.updated, []);
	assert.notEqual(created.newState, before);

	await db.update(m.messages).set({ read: true }).where(m.eq(m.messages.id, id));
	const updated = await call("Email/changes", { sinceState: created.newState });
	assert.deepEqual(updated.updated, [id]);
	assert.deepEqual(updated.created, []);

	// The whole history from before the insert still reads as a single create.
	const sinceStart = await call("Email/changes", { sinceState: before });
	assert.deepEqual(sinceStart.created, [id]);
	assert.deepEqual(sinceStart.updated, []);

	await db.delete(m.messages).where(m.eq(m.messages.id, id));
	const destroyed = await call("Email/changes", { sinceState: updated.newState });
	assert.deepEqual(destroyed.destroyed, [id]);
	// Created and destroyed inside one window cancels out.
	const whole = await call("Email/changes", { sinceState: before });
	assert.deepEqual([whole.created, whole.updated, whole.destroyed], [[], [], []]);
});

test("the session state depends on the account only, never on mail", async () => {
	const before = await m.sessionState(newContext());
	await insertMessage();
	assert.equal(await m.sessionState(newContext()), before);
	assert.notEqual(await m.getMailboxState(newContext()), before);
});

test("change rows are read only up to the sequence reported as the new state", async () => {
	const since = Number(await m.getEmailState(newContext()));
	const first = await insertMessage();
	const upper = Number(await m.getEmailState(newContext()));
	await insertMessage();
	const rows = await m.loadChangeRows(newContext(), [MAILBOX], since, upper, "email");
	assert.deepEqual(rows.map((row) => row.objectId), [first]);
});

test("writes that do not change the JMAP Email object do not move the state", async () => {
	const id = await insertMessage({ read: true });
	const state = await m.getEmailState(newContext());
	await db.update(m.messages).set({ spamScore: 3, spamVerdict: "inbox", spamAnalyzedAt: new Date() }).where(m.eq(m.messages.id, id));
	await db.update(m.messages).set({ read: true }).where(m.eq(m.messages.id, id));
	assert.equal(await m.getEmailState(newContext()), state);
});

test("unknown, outdated and future states answer cannotCalculateChanges", async () => {
	const legacy = await call("Email/changes", { sinceState: "12.345.6.7.8.0" });
	assert.equal(legacy.name, "error");
	assert.equal(legacy.type, "cannotCalculateChanges");
	const future = await call("Email/changes", { sinceState: String(Number(await m.getEmailState(newContext())) + 50) });
	assert.equal(future.type, "cannotCalculateChanges");
	const thread = await call("Thread/changes", { sinceState: "nonsense" });
	assert.equal(thread.type, "cannotCalculateChanges");
	const mailbox = await call("Mailbox/changes", { sinceState: "3.4.5.6.7.8.9.0" });
	assert.equal(mailbox.type, "cannotCalculateChanges");
});

test("maxChanges cuts on a sequence boundary and hasMoreChanges resumes from newState", async () => {
	const before = await m.getEmailState(newContext());
	const ids = [await insertMessage(), await insertMessage(), await insertMessage()];
	const first = await call("Email/changes", { sinceState: before, maxChanges: 2 });
	assert.deepEqual(first.created, ids.slice(0, 2));
	assert.equal(first.hasMoreChanges, true);
	const second = await call("Email/changes", { sinceState: first.newState, maxChanges: 2 });
	assert.deepEqual(second.created, [ids[2]]);
	assert.equal(second.hasMoreChanges, false);
	assert.equal(second.newState, await m.getEmailState(newContext()));
	const invalid = await call("Email/changes", { sinceState: before, maxChanges: 0 });
	assert.equal(invalid.type, "invalidArguments");
});

test("Thread/changes follows the messages in a thread", async () => {
	const before = await m.getEmailState(newContext());
	const root = await insertMessage();
	const created = await call("Thread/changes", { sinceState: before });
	assert.deepEqual(created.created, [root]);

	const reply = await insertMessage({ threadId: root });
	const updated = await call("Thread/changes", { sinceState: created.newState });
	assert.deepEqual(updated.updated, [root]);
	assert.deepEqual(updated.created, []);

	const got = await call("Thread/get", { ids: [root] });
	assert.deepEqual(got.list, [{ id: root, emailIds: [root, reply] }]);

	await db.delete(m.messages).where(m.eq(m.messages.threadId, root));
	await db.delete(m.messages).where(m.eq(m.messages.id, root));
	const destroyed = await call("Thread/changes", { sinceState: updated.newState });
	assert.deepEqual(destroyed.destroyed, [root]);
});

test("Mailbox/changes reports count-only updates and folder lifecycle", async () => {
	const before = await m.getMailboxState(newContext());
	await insertMessage();
	const counts = await call("Mailbox/changes", { sinceState: before });
	assert.equal(counts.name, "Mailbox/changes");
	assert.ok(counts.updated.includes(INBOX));
	assert.ok(counts.updated.includes(MAILBOX));
	assert.deepEqual(counts.updatedProperties, ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"]);
	assert.deepEqual(counts.created, []);

	await db.insert(m.folders).values({ id: "fld_1", userId: USER.id, mailboxId: MAILBOX, name: "Receipts" });
	const folderRef = m.encodeMailboxRef({ kind: "folder", mailboxId: MAILBOX, folderId: "fld_1" });
	const created = await call("Mailbox/changes", { sinceState: counts.newState });
	assert.deepEqual(created.created, [folderRef]);

	await db.update(m.folders).set({ name: "Invoices" }).where(m.eq(m.folders.id, "fld_1"));
	const renamed = await call("Mailbox/changes", { sinceState: created.newState });
	assert.deepEqual(renamed.updated, [folderRef]);
	assert.equal(renamed.updatedProperties, null);

	await db.delete(m.folders).where(m.eq(m.folders.id, "fld_1"));
	const destroyed = await call("Mailbox/changes", { sinceState: renamed.newState });
	assert.deepEqual(destroyed.destroyed, [folderRef]);

	// A different set of accessible mailboxes invalidates the digest.
	const foreign = await call("Mailbox/changes", { sinceState: `${destroyed.newState.split("-")[0]}-00000000` });
	assert.equal(foreign.type, "cannotCalculateChanges");
});

test("Email/queryChanges removes changed ids and adds back the ones that still match", async () => {
	const query = { filter: { inMailbox: INBOX }, sort: [{ property: "receivedAt", isAscending: false }] };
	const initial = await call("Email/query", query);
	assert.equal(initial.canCalculateChanges, true);
	const newest = await insertMessage();
	const added = await call("Email/queryChanges", { ...query, sinceQueryState: initial.queryState, calculateTotal: true });
	assert.equal(added.name, "Email/queryChanges");
	assert.deepEqual(added.removed, [newest]);
	assert.deepEqual(added.added, [{ id: newest, index: 0 }]);
	assert.equal(added.total, initial.ids.length + 1);
	// One id removed and re-added counts twice against maxChanges.
	const capped = await call("Email/queryChanges", { ...query, sinceQueryState: initial.queryState, maxChanges: 1 });
	assert.equal(capped.type, "tooManyChanges");

	await db.update(m.messages).set({ status: "archived" }).where(m.eq(m.messages.id, newest));
	const removed = await call("Email/queryChanges", { ...query, sinceQueryState: added.newQueryState });
	assert.deepEqual(removed.removed, [newest]);
	assert.deepEqual(removed.added, []);
});

test("Email/queryChanges with collapseThreads re-adds the thread's current representative", async () => {
	const query = { filter: { inMailbox: INBOX }, sort: [{ property: "receivedAt", isAscending: false }], collapseThreads: true };
	const root = await insertMessage();
	const initial = await call("Email/query", query);
	assert.equal(initial.ids[0], root);
	const reply = await insertMessage({ threadId: root });
	const changes = await call("Email/queryChanges", { ...query, sinceQueryState: initial.queryState });
	// The old representative has no change row of its own but is displaced, so it is removed too.
	assert.deepEqual(new Set(changes.removed), new Set([root, reply]));
	assert.deepEqual(changes.added, [{ id: reply, index: 0 }]);
});

test("pruning drops old history from the front and keeps the newest row", async () => {
	const before = await m.getEmailState(newContext());
	await insertMessage();
	const middle = await m.getEmailState(newContext());
	await insertMessage();
	const fortyDaysAgo = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60;
	await db.run(m.sql`update jmap_change_log set created_at = ${fortyDaysAgo} where seq <= ${Number(middle)}`);
	m.resetPruneTimer();
	await m.pruneChangeLog(newContext());
	const [{ oldest }] = await db.all(m.sql`select min(seq) as oldest from jmap_change_log`);
	assert.equal(oldest, Number(middle) + 1);

	const stale = await call("Email/changes", { sinceState: before });
	assert.equal(stale.type, "cannotCalculateChanges");
	const fresh = await call("Email/changes", { sinceState: middle });
	assert.equal(fresh.name, "Email/changes");
	assert.equal(fresh.created.length, 1);

	// Everything old on a quiet server: the newest row survives so the state does not regress.
	await db.run(m.sql`update jmap_change_log set created_at = ${fortyDaysAgo}`);
	m.resetPruneTimer();
	await m.pruneChangeLog(newContext());
	assert.equal(await m.getEmailState(newContext()), fresh.newState);
});

test("state reads are memoized for the request and refreshed by a write in it", async () => {
	const id = await insertMessage({ read: false });
	const [first, set, second] = await callAll([
		["Email/get", { ids: [id], properties: ["id"] }],
		["Email/set", { update: { [id]: { "keywords/$seen": true } } }],
		["Email/get", { ids: [id], properties: ["id"] }],
	]);
	assert.equal(set.name, "Email/set");
	assert.deepEqual(set.updated, { [id]: null });
	assert.equal(first.state, set.oldState);
	assert.notEqual(set.newState, set.oldState);
	assert.equal(second.state, set.newState);
	assert.equal(second.state, await m.getEmailState(newContext()));
});

test("a read-only bundle reads the change-log sequence and the accessible mailboxes once", async () => {
	const id = await insertMessage();
	const statements = await recordStatements(async () => {
		const results = await callAll([
			["Mailbox/get", { ids: null }],
			["Email/query", { filter: { inMailbox: INBOX } }],
			["Thread/get", { ids: [id] }],
			["Email/get", { ids: [id], properties: ["id"] }],
		]);
		assert.deepEqual(results.map((result) => result.name), ["Mailbox/get", "Email/query", "Thread/get", "Email/get"]);
		const states = [results[1].queryState, results[2].state, results[3].state];
		assert.ok(states.every((state) => state === states[0]), "every method in the request reports the same state");
	});
	const sequenceReads = statements.filter((sql) => /max\("?seq"?\) from "?jmap_change_log"?/i.test(sql));
	assert.equal(sequenceReads.length, 1, `expected one sequence read, got:\n${sequenceReads.join("\n")}`);
	// The access lookup is the owned-mailboxes join plus the license check; both run once for the request.
	const mailboxReads = statements.filter((sql) => /from "?mailboxes"? inner join "?domains"?/i.test(sql));
	const licenseReads = statements.filter((sql) => /from "?license_settings"?/i.test(sql));
	assert.equal(mailboxReads.length, 1, `expected one accessible-mailboxes read, got ${mailboxReads.length}`);
	assert.equal(licenseReads.length, 1, `expected one license read, got ${licenseReads.length}`);
});

test("a shared context still sees a mailbox added between requests", async () => {
	const context = newContext();
	const before = await m.listAccessibleMailboxIdSet(context);
	assert.deepEqual([...before], [MAILBOX]);
	await db.insert(m.mailboxes).values({ id: "mbx_second", userId: USER.id, domainId: "dom_test", localPart: "second" });
	try {
		assert.deepEqual([...(await m.listAccessibleMailboxIdSet(context))], [MAILBOX]);
		assert.deepEqual([...(await m.listAccessibleMailboxIdSet(newContext()))].sort(), [MAILBOX, "mbx_second"].sort());
		// A write in the request forgets the memo along with the state, so its newState also sees the new mailbox.
		const [set] = await callAll([["Mailbox/set", { create: { f: { parentId: m.encodeMailboxRef({ kind: "account", mailboxId: "mbx_second" }), name: "Later" } } }]]);
		assert.equal(set.name, "Mailbox/set");
		assert.ok(set.created.f, "the folder was created under the new mailbox");
		await db.delete(m.folders).where(m.eq(m.folders.mailboxId, "mbx_second"));
	} finally {
		await db.delete(m.mailboxes).where(m.eq(m.mailboxes.id, "mbx_second"));
	}
});

test("event-source ticks and reused contexts see writes once the memo is forgotten", async () => {
	const context = newContext();
	const before = await m.getEmailState(context);
	await insertMessage();
	assert.equal(await m.getEmailState(context), before);
	m.forgetMemo(context);
	assert.notEqual(await m.getEmailState(context), before);
});

test("memoize shares one computation per key and drops a rejected one", async () => {
	const context = newContext();
	let calls = 0;
	const compute = async () => (calls += 1);
	const [a, b] = await Promise.all([m.memoize(context, "k", compute), m.memoize(context, "k", compute)]);
	assert.deepEqual([a, b, calls], [1, 1, 1]);
	assert.equal(await m.memoize(context, "other", compute), 2);
	await assert.rejects(m.memoize(context, "bad", async () => { throw new Error("boom"); }));
	assert.equal(await m.memoize(context, "bad", async () => "recovered"), "recovered");
	m.forgetMemo(context);
	assert.equal(await m.memoize(context, "k", compute), 3);
});

test("pure helpers: window cutting and classification", () => {
	const rows = [
		{ seq: 1, type: "email", objectId: "a", mailboxId: "m", threadKey: "a", kind: "created" },
		{ seq: 2, type: "email", objectId: "a", mailboxId: "m", threadKey: "a", kind: "updated" },
		{ seq: 3, type: "email", objectId: "b", mailboxId: "m", threadKey: "b", kind: "updated" },
		{ seq: 4, type: "email", objectId: "c", mailboxId: "m", threadKey: "c", kind: "created" },
		{ seq: 5, type: "email", objectId: "c", mailboxId: "m", threadKey: "c", kind: "destroyed" },
		{ seq: 6, type: "email", objectId: "d", mailboxId: "m", threadKey: "d", kind: "destroyed" },
	];
	assert.deepEqual(m.classifyChanges(rows), { created: ["a"], updated: ["b"], destroyed: ["d"] });
	const window = m.takeChangeWindow(rows, (row) => row.objectId, 2, 9);
	assert.deepEqual(window.rows.map((row) => row.seq), [1, 2, 3]);
	assert.deepEqual([window.newSeq, window.hasMore], [3, true]);
	assert.deepEqual(m.takeChangeWindow(rows, (row) => row.objectId, null, 9), { rows, newSeq: 9, hasMore: false });
	assert.deepEqual(m.diffQueryResults(["b", "x"], ["a", "b", "c"], null), { removed: ["b", "x"], added: [{ id: "b", index: 1 }] });
	assert.deepEqual(m.diffQueryResults(["c"], ["a", "b", "c"], "b").added, []);
	assert.equal(m.parseSeqState("42"), 42);
	assert.equal(m.parseSeqState("4.2"), null);
	assert.equal(m.parseSeqState(42), null);
});
