import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle", "migrations");
const BODY_SIZE_MIGRATION = "0040_add_message_body_size.sql";

/**
 * Email/get reads message bodies only for the properties built from them, and
 * answers `size` from the trigger-maintained `body_size` column (migration
 * 0040). Both are exercised against the repository's migrations applied to an
 * in-memory SQLite database through the self-hosted runtime's D1 wrapper, as
 * in jmap-changes.test.mjs; no Workers binding is involved.
 */
// The bundle keeps better-sqlite3 (a native module) external, so it is written
// under node_modules where Node can resolve that package from it.
const cacheDir = join(root, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "mailflare-jmap-email-get-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { users, domains, mailboxes, messages, messageAttachments, jmapChangeLog } from "./src/db/schema/index.ts";
			export { processRequest, validateRequest } from "./src/lib/jmap/processor.ts";
			export { emailNeedsBodies, emailNeedsAttachments, chunkForParameters, D1_MAX_PARAMETERS } from "./src/lib/jmap/email-objects-utils.ts";
			export { eq, sql } from "drizzle-orm";
		`,
		resolveDir: root,
		sourcefile: "jmap-email-get-test-entry.js",
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
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

/** What an Apple Mail message list asks for. */
const LIST_PROPERTIES = ["id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt", "messageId", "inReplyTo", "references", "from", "to", "cc", "subject", "sentAt", "hasAttachment", "preview"];
const HEADER_PROPERTIES = ["header:Message-ID:asText", "header:Message-ID:asMessageIds", "header:Subject", "header:From:asAddresses", "header:References:asMessageIds", "header:Date:asDate"];

const SAMPLES = {
	ascii: "Plain ASCII body.",
	emoji: "Grüße 👋🏽 from 東京! 🎉🚀",
	combining: "é ä 한국어",
	nul: "before\u0000after",
	loneSurrogate: "broken \ud83d pair",
	empty: "",
};

function utf8Length(value) {
	return new TextEncoder().encode(value ?? "").length;
}

let database;
let db;
let counter = 0;

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

async function seedAccount(target) {
	await target.insert(m.users).values({ id: USER.id, email: USER.email, passwordHash: "x", name: "Test" });
	await target.insert(m.domains).values({ id: "dom_test", userId: USER.id, hostname: "example.test", zoneId: "zone", status: "active" });
	await target.insert(m.mailboxes).values({ id: MAILBOX, userId: USER.id, domainId: "dom_test", localPart: "me" });
}

async function insertMessage(overrides = {}, target = db) {
	counter += 1;
	const id = `msg_${String(counter).padStart(4, "0")}`;
	await target.insert(m.messages).values({
		id,
		userId: USER.id,
		mailboxId: MAILBOX,
		direction: "inbound",
		providerMessageId: `<${id}@example.org>`,
		fromAddr: "Sender <sender@example.org>",
		toAddr: "me@example.test",
		subject: `Message ${counter}`,
		snippet: `Snippet ${counter}`,
		textBody: "Hello",
		htmlBody: "<p>Hello</p>",
		status: "received",
		references: "a@example.org b@example.org",
		createdAt: new Date(1_700_000_000_000 + counter * 60_000),
		...overrides,
	});
	return id;
}

function bodySizeOf(id, target = database) {
	return target.db.prepare("SELECT body_size FROM messages WHERE id = ?").get(id).body_size;
}

function changeLogCount(target = database) {
	return target.db.prepare("SELECT count(*) AS n FROM jmap_change_log").get().n;
}

async function call(name, args) {
	const response = await m.processRequest(newContext(), m.validateRequest({ using: USING, methodCalls: [[name, { accountId: USER.id, ...args }, "c1"]] }));
	const [responseName, result] = response.methodResponses[0];
	return { name: responseName, ...result };
}

/** Every statement prepared while `run` executes, with the parameters it was bound to. */
async function recordStatements(run) {
	const recorded = [];
	const original = database.prepare;
	database.prepare = (sql) => {
		const statement = original.call(database, sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...params) => {
			recorded.push({ sql, params });
			return bind(...params);
		};
		return statement;
	};
	try {
		await run();
	} finally {
		database.prepare = original;
	}
	return recorded;
}

/** Bytes of every value a statement returns, as D1 would hand them back. */
function resultBytes({ sql, params }) {
	const rows = database.db.prepare(sql).raw(true).all(...params.map((value) => (typeof value === "boolean" ? Number(value) : value)));
	return rows.flat().reduce((total, value) => total + (typeof value === "string" ? utf8Length(value) : 8), 0);
}

const ids = {};
/** 200 plain messages, inserted by the 200-id test and reused after it. */
const many = [];

before(async () => {
	database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, migrationsDir);
	db = m.createDb(database);
	await seedAccount(db);
	ids.plain = await insertMessage();
	ids.emoji = await insertMessage({ textBody: SAMPLES.emoji, htmlBody: `<p>${SAMPLES.emoji}</p>` });
	ids.htmlOnlyNoSnippet = await insertMessage({ snippet: null, textBody: null, htmlBody: "<style>.x{}</style><p>Only   HTML 東京</p>" });
	ids.noBodies = await insertMessage({ snippet: null, textBody: null, htmlBody: null, references: null });
	ids.stale = await insertMessage({ textBody: SAMPLES.combining, htmlBody: null });
	ids.large = await insertMessage({ htmlBody: `<div>${"x".repeat(200_000)}</div>` });
	ids.attached = await insertMessage({ textBody: "See attached 📎", htmlBody: null });
	await db.insert(m.messageAttachments).values([
		{ id: "att_1", messageId: ids.attached, filename: "report.pdf", contentType: "application/pdf", size: 3210, disposition: "attachment", r2Key: "k1" },
		{ id: "att_2", messageId: ids.attached, filename: "dot.png", contentType: "image/png", size: 68, disposition: "inline", contentId: "<dot@x>", r2Key: "k2" },
	]);
	// A row the backfill has not reached (inserted by code deployed before the migration ran).
	database.db.prepare("UPDATE messages SET body_size = NULL WHERE id = ?").run(ids.stale);
});

test("emailNeedsBodies: only body parts and fetched body values read the bodies", () => {
	assert.equal(m.emailNeedsBodies(null, false), true, "properties null means every property");
	assert.equal(m.emailNeedsBodies(undefined, false), true);
	assert.equal(m.emailNeedsBodies(LIST_PROPERTIES, false), false);
	assert.equal(m.emailNeedsBodies(LIST_PROPERTIES, true), false, "fetch flags without bodyValues fetch nothing");
	assert.equal(m.emailNeedsBodies([...HEADER_PROPERTIES, "id"], false), false);
	assert.equal(m.emailNeedsBodies(["bodyValues"], false), false, "bodyValues is {} without a fetch flag");
	assert.equal(m.emailNeedsBodies(["bodyValues"], true), true);
	for (const property of ["bodyStructure", "textBody", "htmlBody"]) assert.equal(m.emailNeedsBodies(["id", property], false), true, property);
	assert.equal(m.emailNeedsBodies(["id", "attachments", "hasAttachment", "unknownThing"], false), false);
});

test("emailNeedsAttachments: size, hasAttachment, attachments and bodyStructure read attachment rows", () => {
	assert.equal(m.emailNeedsAttachments(null), true);
	for (const property of ["size", "hasAttachment", "attachments", "bodyStructure"]) assert.equal(m.emailNeedsAttachments(["id", property]), true, property);
	assert.equal(m.emailNeedsAttachments(["id", "subject", "keywords", "mailboxIds", "preview", "textBody", "htmlBody", ...HEADER_PROPERTIES]), false);
});

test("chunkForParameters keeps every statement within D1's parameter limit", () => {
	const items = Array.from({ length: 250 }, (_, index) => index);
	const chunks = m.chunkForParameters(items, 3);
	assert.deepEqual(chunks.flat(), items, "nothing is lost or reordered");
	assert.ok(chunks.every((chunk) => chunk.length + 3 <= m.D1_MAX_PARAMETERS));
	assert.equal(chunks[0].length, 97);
	assert.deepEqual(m.chunkForParameters([], 1), []);
	assert.deepEqual(m.chunkForParameters([1, 2], 500), [[1], [2]], "a scope that alone exceeds the limit still makes progress");
});

test("body_size is the UTF-8 byte count TextEncoder gives, on insert and on every body edit", async () => {
	for (const [name, text] of Object.entries(SAMPLES)) {
		const html = name === "empty" ? null : `<b>${text}</b>`;
		const id = await insertMessage({ textBody: text, htmlBody: html });
		const stored = database.db.prepare("SELECT text_body, html_body FROM messages WHERE id = ?").get(id);
		// Compare against what the database holds: SQLite stores a lone surrogate as U+FFFD, as TextEncoder encodes it.
		assert.equal(bodySizeOf(id), utf8Length(stored.text_body) + utf8Length(stored.html_body), name);
		assert.equal(bodySizeOf(id), utf8Length(text) + utf8Length(html), `${name} matches TextEncoder on the original string`);
	}
	const id = await insertMessage({ textBody: "short", htmlBody: null });
	await db.update(m.messages).set({ htmlBody: "<p>🎉 now with html</p>" }).where(m.eq(m.messages.id, id));
	assert.equal(bodySizeOf(id), utf8Length("short") + utf8Length("<p>🎉 now with html</p>"));
	await db.update(m.messages).set({ textBody: null }).where(m.eq(m.messages.id, id));
	assert.equal(bodySizeOf(id), utf8Length("<p>🎉 now with html</p>"));
	await db.update(m.messages).set({ read: true, subject: "Renamed" }).where(m.eq(m.messages.id, id));
	assert.equal(bodySizeOf(id), utf8Length("<p>🎉 now with html</p>"), "other edits leave it alone");
});

test("the body_size triggers add no change-log rows and do not recurse", async () => {
	const before = changeLogCount();
	const id = await insertMessage({ textBody: "one" });
	assert.equal(changeLogCount(), before + 1, "an insert logs once");
	await db.update(m.messages).set({ textBody: "two 🎉" }).where(m.eq(m.messages.id, id));
	assert.equal(changeLogCount(), before + 2, "a body edit logs once, not twice");
	await db.update(m.messages).set({ read: true }).where(m.eq(m.messages.id, id));
	assert.equal(changeLogCount(), before + 3);
	const backfill = readFileSync(join(migrationsDir, BODY_SIZE_MIGRATION), "utf8").split(/-->\s*statement-breakpoint/).pop().trim();
	assert.match(backfill, /^UPDATE `messages` SET `body_size`/);
	const changes = database.db.prepare(backfill).run().changes;
	assert.ok(changes > 5, "the backfill touches every row");
	assert.equal(changeLogCount(), before + 3, "the backfill logs nothing");
	const fts = database.db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'two'").get().n;
	assert.equal(fts, 1, "the search index is untouched");
	// The stale row stays stale for the remaining tests.
	database.db.prepare("UPDATE messages SET body_size = NULL WHERE id = ?").run(ids.stale);
});

test("the migration backfills rows that existed before it, without logging them", async () => {
	const partialDir = mkdtempSync(join(outDir, "migrations-"));
	cpSync(migrationsDir, partialDir, { recursive: true, filter: (source) => !source.endsWith(BODY_SIZE_MIGRATION) });
	const old = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(old, partialDir);
	const oldDb = m.createDb(old);
	await seedAccount(oldDb);
	// Insert through raw SQL: the schema already names body_size, which this database lacks.
	const insert = old.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, text_body, html_body, status, created_at) VALUES (?, ?, ?, 'inbound', 'a@x', 'b@x', ?, ?, 'received', 1)");
	const rows = Object.entries(SAMPLES).map(([name, text], index) => [`old_${index}`, text || null, name === "nul" ? null : `<i>${text}</i>`]);
	for (const [id, text, html] of rows) insert.run(id, USER.id, MAILBOX, text, html);
	const logged = changeLogCount(old);
	assert.deepEqual(await m.applyMigrations(old, migrationsDir), [BODY_SIZE_MIGRATION]);
	for (const [id] of rows) {
		const stored = old.db.prepare("SELECT text_body, html_body, body_size FROM messages WHERE id = ?").get(id);
		assert.equal(stored.body_size, utf8Length(stored.text_body) + utf8Length(stored.html_body), id);
	}
	assert.equal(changeLogCount(old), logged, "the backfill logs nothing");
});

test("a metadata Email/get does not read the bodies and answers what a full fetch answers", async () => {
	const all = Object.values(ids);
	let list;
	const statements = await recordStatements(async () => {
		const result = await call("Email/get", { ids: all, properties: [...LIST_PROPERTIES, ...HEADER_PROPERTIES] });
		list = result.list;
	});
	const select = statements.find((statement) => /from "messages"/.test(statement.sql));
	assert.ok(select, "messages are read");
	const projection = select.sql.slice(0, select.sql.indexOf(' from "messages"'));
	assert.doesNotMatch(projection, /(^select |, )"(text_body|html_body)"/, "neither body is a selected column");
	// Only the snippet-less row's HTML (for preview) and the stale row's size come back.
	assert.ok(resultBytes(select) < 4_000, `${resultBytes(select)} bytes returned`);

	const full = await call("Email/get", { ids: all, properties: null, fetchAllBodyValues: true });
	const fullById = new Map(full.list.map((item) => [item.id, item]));
	const fullSelect = (await recordStatements(() => call("Email/get", { ids: all, properties: null }))).find((statement) => /from "messages"/.test(statement.sql));
	assert.ok(resultBytes(fullSelect) > 200_000, "a full fetch does read the bodies");

	assert.equal(list.length, all.length);
	for (const item of list) {
		const reference = fullById.get(item.id);
		for (const property of LIST_PROPERTIES) assert.deepEqual(item[property], reference[property], `${item.id} ${property}`);
		assert.deepEqual(Object.keys(item), ["id", ...LIST_PROPERTIES.slice(1), ...HEADER_PROPERTIES], "properties in the order asked");
		const values = Object.values(reference.bodyValues).reduce((total, value) => total + utf8Length(value.value), 0);
		const attachments = reference.attachments.reduce((total, part) => total + part.size, 0);
		assert.equal(item.size, values + attachments, `${item.id} size is its body bytes plus its attachments`);
	}
	const byId = new Map(list.map((item) => [item.id, item]));
	assert.equal(byId.get(ids.htmlOnlyNoSnippet).preview, "Only HTML 東京", "preview falls back to the HTML when there is no snippet");
	assert.equal(byId.get(ids.noBodies).preview, "");
	assert.equal(byId.get(ids.stale).size, utf8Length(SAMPLES.combining), "a row with no body_size yet still gets its size");
	assert.equal(byId.get(ids.attached).hasAttachment, true);
	assert.equal(byId.get(ids.attached).size, utf8Length("See attached 📎") + 3210 + 68);
	assert.equal(byId.get(ids.plain)["header:Message-ID:asText"], `<${ids.plain}@example.org>`);
	assert.deepEqual(byId.get(ids.plain)["header:References:asMessageIds"], ["a@example.org", "b@example.org"]);
});

test("body properties still read the bodies and keep each part's own size", async () => {
	const result = await call("Email/get", { ids: [ids.emoji, ids.attached, ids.htmlOnlyNoSnippet], properties: ["bodyStructure", "textBody", "htmlBody", "attachments"] });
	const byId = new Map(result.list.map((item) => [item.id, item]));
	const emoji = byId.get(ids.emoji);
	assert.equal(emoji.textBody[0].size, utf8Length(SAMPLES.emoji));
	assert.equal(emoji.htmlBody[0].size, utf8Length(`<p>${SAMPLES.emoji}</p>`));
	assert.equal(emoji.bodyStructure.type, "multipart/alternative");
	assert.equal(emoji.bodyStructure.size, utf8Length(SAMPLES.emoji) + utf8Length(`<p>${SAMPLES.emoji}</p>`));
	const attached = byId.get(ids.attached);
	assert.equal(attached.bodyStructure.type, "multipart/mixed");
	assert.deepEqual(attached.attachments.map((part) => part.name), ["dot.png", "report.pdf"], "inline parts first, as before");
	assert.deepEqual(byId.get(ids.htmlOnlyNoSnippet).textBody, byId.get(ids.htmlOnlyNoSnippet).htmlBody, "an HTML-only message offers its HTML as textBody");

	const values = await call("Email/get", { ids: [ids.emoji], properties: ["bodyValues"], fetchTextBodyValues: true, maxBodyValueBytes: 5 });
	assert.deepEqual(values.list[0].bodyValues["1"], { value: SAMPLES.emoji.slice(0, 5), isEncodingProblem: false, isTruncated: true });
	const unfetched = await call("Email/get", { ids: [ids.emoji], properties: ["bodyValues"] });
	assert.deepEqual(unfetched.list[0].bodyValues, {});
});

test("Email/get of 200 ids splits its lookups to stay within D1's parameter limit", async () => {
	for (let index = 0; index < 200; index += 1) many.push(await insertMessage());
	let result;
	const statements = await recordStatements(async () => {
		result = await call("Email/get", { ids: many, properties: LIST_PROPERTIES });
	});
	assert.equal(result.name, "Email/get");
	assert.equal(result.list.length, 200);
	assert.deepEqual(result.notFound, []);
	assert.ok(statements.every((statement) => statement.params.length <= m.D1_MAX_PARAMETERS), statements.map((statement) => statement.params.length).join(","));
	assert.equal(new Set(result.list.map((item) => item.id)).size, 200, "no row twice");
	const unknown = await call("Email/get", { ids: [...many.slice(0, 120), "msg_missing"], properties: ["id"] });
	assert.deepEqual(unknown.notFound, ["msg_missing"]);
});

test("Email/get looks messages up by id and still only returns the account's own", async () => {
	await db.insert(m.users).values({ id: "usr_other", email: "other@example.test", passwordHash: "x", name: "Other" });
	await db.insert(m.mailboxes).values({ id: "mbx_other", userId: "usr_other", domainId: "dom_test", localPart: "other" });
	// A second mailbox of the user's, so the scope is an IN list as on a real account.
	await db.insert(m.mailboxes).values({ id: "mbx_second", userId: USER.id, domainId: "dom_test", localPart: "second" });
	const foreign = await insertMessage({ userId: "usr_other", mailboxId: "mbx_other" });
	let result;
	const statements = await recordStatements(async () => {
		result = await call("Email/get", { ids: [...many.slice(0, 40), foreign], properties: LIST_PROPERTIES });
	});
	assert.deepEqual(result.list.map((item) => item.id).sort(), many.slice(0, 40).sort());
	assert.deepEqual(result.notFound, [foreign], "another account's message is not found");
	const select = statements.find((statement) => /from "messages"/.test(statement.sql));
	const plan = database.db.prepare(`EXPLAIN QUERY PLAN ${select.sql}`).all(...select.params).map((row) => row.detail).join("\n");
	// Without the unary + SQLite (no ANALYZE stats, as on D1) picks the mailbox index once a request names a few ids.
	assert.match(plan, /USING INDEX sqlite_autoindex_messages_1 \(id=\?\)/, plan);
});

test("Email/get answers in the order asked, once per id", async () => {
	const asked = [many[150], ids.emoji, "msg_missing", many[3], ids.emoji, many[99], "msg_missing"];
	const result = await call("Email/get", { ids: asked, properties: ["id"] });
	assert.deepEqual(result.list.map((item) => item.id), [many[150], ids.emoji, many[3], many[99]]);
	assert.deepEqual(result.notFound, ["msg_missing"]);
});
