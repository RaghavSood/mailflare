import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Email/query reads a plain page with LIMIT/OFFSET and answers anchors,
 * negative positions and collapseThreads from the materialised list. Both
 * paths run here against a real SQLite database built from the repository's
 * migrations (the self-hosted runtime's D1-compatible wrapper, in memory), so
 * the `text` filter also runs against the real `messages_fts` index.
 */
const cacheDir = join(root, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "mailflare-jmap-query-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { users, domains, mailboxes, folders, messages } from "./src/db/schema/index.ts";
			export { eq } from "drizzle-orm";
			export { processRequest, validateRequest } from "./src/lib/jmap/processor.ts";
			export { encodeMailboxRef } from "./src/lib/jmap/ids.ts";
			export { QUERY_WINDOW, describeEmailQueryShape, fitsLikePattern, jmapTextMatch, planEmailQueryPage, queryLimit, windowedPage } from "./src/lib/jmap/email-query-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "jmap-query-test-entry.js",
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

const USER = { id: "usr_q", email: "me@example.test", role: "user" };
const MAILBOX = "mbx_q";
const OTHER = "mbx_q2";
const FOLDER = "fld_q";
const ref = (mailboxId, role) => m.encodeMailboxRef({ kind: "role", mailboxId, role });
const INBOX = ref(MAILBOX, "inbox");
const SENT = ref(MAILBOX, "sent");
const FOLDER_REF = m.encodeMailboxRef({ kind: "folder", mailboxId: MAILBOX, folderId: FOLDER });

let database;
let db;

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

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

async function call(name, args) {
	const request = m.validateRequest({ using: USING, methodCalls: [[name, { accountId: USER.id, ...args }, "c1"]] });
	const response = await m.processRequest(newContext(), request);
	const [[responseName, result]] = response.methodResponses;
	return { name: responseName, ...result };
}

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

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function seeded(seed) {
	return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
}

const WORDS = ["invoice", "budget", "quarterly", "report", "meeting", "deploy", "renewal", "receipt"];
const PEOPLE = ["maya@acme.test", "sam@okoro.test", "lena@fischer.test"];

/**
 * Raw inserts, so the fixture is fast and created_at ties are common (three
 * messages share most seconds): ties are where a different plan or a
 * LIMIT could reorder rows, so they are what the comparisons must cover.
 */
function insertMessages(count, { prefix = "m", mailboxId = MAILBOX, start = 1_780_000_000, status } = {}) {
	const rand = seeded(count + start);
	const insert = database.db.prepare(`insert into messages (id, user_id, mailbox_id, direction, from_addr, to_addr, cc_addr, subject, snippet, status, thread_id, created_at, read, folder_id, starred, text_body, html_body)
		values (@id, @user, @mailbox, @direction, @from, @to, @cc, @subject, @snippet, @status, @thread, @created, @read, @folder, @starred, @text, @html)`);
	const threads = [];
	database.db.transaction(() => {
		for (let i = 0; i < count; i++) {
			const id = `${prefix}_${String(i).padStart(5, "0")}`;
			const kind = status ?? ["received", "received", "received", "sent", "queued", "failed", "folder", "archived", "draft"][Math.floor(rand() * 9)];
			const outbound = ["sent", "queued", "failed", "draft"].includes(kind);
			const word = WORDS[Math.floor(rand() * WORDS.length)];
			const person = PEOPLE[Math.floor(rand() * PEOPLE.length)];
			let thread = null;
			if (threads.length && rand() < 0.3) thread = threads[Math.floor(rand() * threads.length)];
			else if (rand() < 0.2) threads.push(id);
			insert.run({
				id,
				user: USER.id,
				mailbox: mailboxId,
				direction: outbound ? "outbound" : "inbound",
				from: outbound ? "me@example.test" : person,
				to: outbound ? person : "me@example.test",
				cc: i % 11 === 0 ? "cc-person@cc.test" : null,
				subject: i % 7 === 0 ? "Weekly sync" : `${word} #${i}`,
				snippet: `About the ${word}`,
				status: kind === "folder" ? "received" : kind,
				thread,
				created: start + Math.floor(i / 3) * 60,
				read: rand() < 0.6 ? 1 : 0,
				folder: kind === "folder" ? FOLDER : null,
				starred: rand() < 0.1 ? 1 : 0,
				text: i % 5 === 0 ? null : `Hello, about the ${word}. Contact ${person}.`,
				html: i % 4 === 0 ? `<p>About the ${word} <a href="https://example.test">link</a></p>` : null,
			});
		}
	})();
}

before(async () => {
	database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, join(root, "drizzle", "migrations"));
	db = m.createDb(database);
	await db.insert(m.users).values({ id: USER.id, email: USER.email, passwordHash: "x", name: "Test" });
	await db.insert(m.domains).values({ id: "dom_q", userId: USER.id, hostname: "example.test", zoneId: "zone", status: "active" });
	await db.insert(m.mailboxes).values([
		{ id: MAILBOX, userId: USER.id, domainId: "dom_q", localPart: "me" },
		{ id: OTHER, userId: USER.id, domainId: "dom_q", localPart: "other" },
	]);
	await db.insert(m.folders).values({ id: FOLDER, userId: USER.id, mailboxId: MAILBOX, name: "Projects" });
	insertMessages(420);
	insertMessages(40, { prefix: "o", mailboxId: OTHER, start: 1_780_000_030 });
});

/** Today's ordered list for a filter and sort: a negative position always takes the materialising path. */
async function referenceList(filter, sort) {
	const head = await call("Email/query", { filter, sort, position: -1, limit: 1, calculateTotal: true });
	const ids = [];
	for (let start = 0; start < head.total; start += 250) {
		const page = await call("Email/query", { filter, sort, position: start - head.total, limit: 250 });
		ids.push(...page.ids);
	}
	return { ids, total: head.total };
}

test("planEmailQueryPage takes LIMIT/OFFSET only for plain non-negative integer pages", () => {
	assert.deepEqual(m.planEmailQueryPage({}), { position: 0, limit: 250 });
	assert.deepEqual(m.planEmailQueryPage({ position: 30, limit: 30 }), { position: 30, limit: 30 });
	assert.deepEqual(m.planEmailQueryPage({ position: "5", limit: "4" }), { position: 5, limit: 4 });
	assert.deepEqual(m.planEmailQueryPage({ limit: 0 }), { position: 0, limit: 0 });
	assert.deepEqual(m.planEmailQueryPage({ limit: 9999 }), { position: 0, limit: 250 });
	assert.deepEqual(m.planEmailQueryPage({ limit: -3 }), { position: 0, limit: 0 });
	assert.deepEqual(m.planEmailQueryPage({ collapseThreads: false, anchor: "" }), { position: 0, limit: 250 });
	assert.deepEqual(m.planEmailQueryPage({ position: null, limit: null }), { position: 0, limit: 250 });
	for (const args of [
		{ anchor: "msg_1" },
		{ collapseThreads: true },
		{ position: -1 },
		{ position: 1.5 },
		{ position: "x" },
		{ limit: 2.5 },
		{ limit: "x" },
		{ position: Number.MAX_SAFE_INTEGER + 2 },
	]) {
		assert.equal(m.planEmailQueryPage(args), null, JSON.stringify(args));
	}
});

test("windowedPage stops at QUERY_WINDOW, like the materialised list", () => {
	assert.equal(m.QUERY_WINDOW, 10_000);
	assert.deepEqual(m.windowedPage({ position: 0, limit: 50 }), { limit: 50, offset: 0 });
	assert.deepEqual(m.windowedPage({ position: 9_990, limit: 50 }), { limit: 10, offset: 9_990 });
	assert.equal(m.windowedPage({ position: 10_000, limit: 50 }), null);
	assert.equal(m.windowedPage({ position: 0, limit: 0 }), null);
});

test("queryLimit keeps the old coercion", () => {
	assert.equal(m.queryLimit(undefined), 250);
	assert.equal(m.queryLimit(null), 250);
	assert.equal(m.queryLimit(10), 10);
	assert.equal(m.queryLimit(1000), 250);
	assert.equal(m.queryLimit(-1), 0);
	assert.ok(Number.isNaN(m.queryLimit("x")));
});

test("jmapTextMatch quotes every term, so client text cannot change the MATCH grammar", () => {
	assert.equal(m.jmapTextMatch("invoice"), '"invoice"*');
	assert.equal(m.jmapTextMatch("quarterly report"), '"quarterly"* AND "report"*');
	assert.equal(m.jmapTextMatch('"weekly sync"'), '"weekly sync"');
	assert.equal(m.jmapTextMatch("maya@acme.test"), '"maya acme test"');
	assert.equal(m.jmapTextMatch("subject:invoice"), '"subject invoice"');
	assert.equal(m.jmapTextMatch("invoice AND OR NOT NEAR"), '"invoice"* AND "AND"* AND "OR"* AND "NOT"* AND "NEAR"*');
	assert.equal(m.jmapTextMatch("NEAR(invoice budget)"), '"NEAR invoice" AND "budget"*');
	assert.equal(m.jmapTextMatch("-invoice"), '"invoice"*', "no negation: JMAP text has no exclusion syntax");
	assert.equal(m.jmapTextMatch('--"weekly sync" re-send'), '"weekly sync" AND "re send"');
	assert.equal(m.jmapTextMatch("a\tb\nc"), '"a"* AND "b"* AND "c"*');
	for (const text of ["", " ", '"', '""', "-", "--", "*", ":", "(", ")", "()", "^", "\\", "%", "_", "!!!", "{}", " \t\n "]) {
		assert.equal(m.jmapTextMatch(text), null, JSON.stringify(text));
	}
	// Whatever the input, every bare word in the expression is an FTS5 operator the builder wrote itself.
	for (const text of ['a" OR "b', "x NOT y", "col:val", "{subject}: x", "a*b", "a^b", 'He said "hi', "会议 📎", "x".repeat(5000)]) {
		const match = m.jmapTextMatch(text);
		assert.ok(match, JSON.stringify(text));
		const outsideQuotes = match.replace(/"(?:[^"]|"")*"/g, "");
		assert.match(outsideQuotes, /^(?:[\s*()]|AND|NOT)*$/, `${JSON.stringify(text)} -> ${match}`);
	}
});

test("fitsLikePattern is D1's 50-byte LIKE limit, counted in UTF-8 bytes with the two wildcards", () => {
	assert.equal(m.fitsLikePattern("!".repeat(48)), true);
	assert.equal(m.fitsLikePattern("!".repeat(49)), false);
	assert.equal(m.fitsLikePattern("€".repeat(16)), true);
	assert.equal(m.fitsLikePattern("€".repeat(17)), false);
});

test("describeEmailQueryShape logs keys and paging but no filter values", () => {
	const shape = m.describeEmailQueryShape(
		{
			filter: { operator: "AND", conditions: [{ inMailbox: "mbx~inbox", text: "secret words" }, { from: "maya@acme.test" }] },
			sort: [{ property: "receivedAt", isAscending: false }, { property: "hasKeyword", keyword: "$seen", isAscending: true }],
			collapseThreads: true,
			anchor: "msg_x",
			anchorOffset: -2,
			position: 0,
			limit: 50,
			calculateTotal: true,
		},
		false,
	);
	assert.deepEqual(shape, {
		filter: { operator: "AND", conditions: [["inMailbox", "text"], ["from"]] },
		sort: ["receivedAt desc", "hasKeyword:$seen asc"],
		collapseThreads: true,
		anchor: true,
		anchorOffset: -2,
		position: 0,
		limit: 50,
		calculateTotal: true,
		fastPath: false,
	});
	const logged = JSON.stringify(shape);
	for (const value of ["secret", "maya", "mbx~inbox", "msg_x"]) assert.ok(!logged.includes(value), value);
	assert.deepEqual(m.describeEmailQueryShape({}, true).filter, null);
});

const FILTERS = {
	none: null,
	inbox: { inMailbox: INBOX },
	sent: { inMailbox: SENT },
	folder: { inMailbox: FOLDER_REF },
	account: { inMailbox: MAILBOX },
	unread: { inMailbox: INBOX, notKeyword: "$seen" },
	or: { operator: "OR", conditions: [{ inMailbox: INBOX }, { inMailbox: SENT }] },
	text: { text: "invoice" },
};
const SORTS = {
	default: undefined,
	receivedAsc: [{ property: "receivedAt", isAscending: true }],
	subject: [{ property: "subject", isAscending: true }],
	seenThenDate: [{ property: "hasKeyword", keyword: "$seen", isAscending: true }, { property: "receivedAt", isAscending: false }],
};
const PAGES = [
	{ position: 0, limit: 30, calculateTotal: true },
	{ position: 0, limit: 30 },
	{},
	{ position: 30, limit: 30 },
	{ position: 1, limit: 7 },
	{ position: 200, limit: 250, calculateTotal: true },
	{ position: 5000, limit: 10, calculateTotal: true },
	{ position: 0, limit: 0, calculateTotal: true },
	{ position: "5", limit: "4" },
];

test("every SQL-paged page is the same slice, position and total as the materialised list", async () => {
	for (const [fName, filter] of Object.entries(FILTERS)) {
		for (const [sName, sort] of Object.entries(SORTS)) {
			const reference = await referenceList(filter, sort);
			if (fName !== "text") assert.ok(reference.total > 20, `${fName}/${sName} has ${reference.total} messages`);
			for (const page of PAGES) {
				const result = await call("Email/query", { filter, sort, ...page });
				const position = Number(page.position ?? 0);
				const expected = reference.ids.slice(position, position + m.queryLimit(page.limit));
				const label = `${fName}/${sName}/${JSON.stringify(page)}`;
				assert.equal(result.name, "Email/query", label);
				assert.equal(result.position, position, label);
				assert.deepEqual(result.ids, expected, label);
				assert.equal(result.total, page.calculateTotal ? reference.total : undefined, label);
			}
		}
	}
});

test("the paged path issues LIMIT/OFFSET and counts only when asked", async () => {
	const plain = await recordStatements(() => call("Email/query", { filter: { inMailbox: INBOX }, position: 30, limit: 30 }));
	const page = plain.filter((sql) => /from "messages"/.test(sql));
	assert.equal(page.length, 1, page.join("\n"));
	assert.match(page[0], /order by "messages"\."created_at" desc limit \? offset \?$/);
	assert.ok(!/coalesce/.test(page[0]), "the page does not read thread keys");

	const counted = await recordStatements(() => call("Email/query", { filter: { inMailbox: INBOX }, limit: 30, calculateTotal: true }));
	assert.equal(counted.filter((sql) => /count\(\*\)/.test(sql)).length, 1);

	const empty = await recordStatements(() => call("Email/query", { filter: { inMailbox: INBOX }, limit: 0, calculateTotal: true }));
	assert.ok(!empty.some((sql) => /limit \? offset/.test(sql)), "a zero limit reads no page");
	assert.equal(empty.filter((sql) => /count\(\*\)/.test(sql)).length, 1);

	for (const args of [{ anchor: "m_00010" }, { collapseThreads: true }, { position: -5 }]) {
		const statements = await recordStatements(() => call("Email/query", { filter: { inMailbox: INBOX }, ...args }));
		const read = statements.filter((sql) => /from "messages"/.test(sql));
		assert.equal(read.length, 1, JSON.stringify(args));
		assert.match(read[0], /^select "id", coalesce\("thread_id", "id"\) .* limit \?$/, JSON.stringify(args));
	}
});

test("anchors, negative positions and collapseThreads answer as before", async () => {
	const reference = await referenceList({ inMailbox: INBOX }, undefined);
	const anchored = await call("Email/query", { filter: { inMailbox: INBOX }, anchor: reference.ids[40], anchorOffset: -3, limit: 5 });
	assert.equal(anchored.position, 37);
	assert.deepEqual(anchored.ids, reference.ids.slice(37, 42));
	assert.equal((await call("Email/query", { anchor: "nope" })).name, "error");

	const tail = await call("Email/query", { filter: { inMailbox: INBOX }, position: -4, calculateTotal: true });
	assert.equal(tail.position, reference.total - 4);
	assert.deepEqual(tail.ids, reference.ids.slice(-4));

	const collapsed = await call("Email/query", { filter: { inMailbox: INBOX }, collapseThreads: true, calculateTotal: true });
	assert.ok(collapsed.total < reference.total, "threads collapse");
	assert.equal(new Set(collapsed.ids).size, collapsed.ids.length);
});

test("Email/queryChanges indexes match Email/query positions", async () => {
	const before = (await call("Email/query", { limit: 0 })).queryState;
	await db.update(m.messages).set({ read: true }).where(m.eq(m.messages.id, "m_00100"));
	await db.update(m.messages).set({ starred: true }).where(m.eq(m.messages.id, "m_00007"));
	for (const [filter, sort] of [
		[{ inMailbox: INBOX }, undefined],
		[null, [{ property: "subject", isAscending: true }]],
	]) {
		const changes = await call("Email/queryChanges", { filter, sort, sinceQueryState: before, calculateTotal: true });
		assert.equal(changes.name, "Email/queryChanges");
		const reference = await referenceList(filter, sort);
		assert.equal(changes.total, reference.total);
		for (const { id, index } of changes.added) {
			assert.equal(reference.ids[index], id);
			const page = await call("Email/query", { filter, sort, position: index, limit: 1 });
			assert.deepEqual(page.ids, [id]);
		}
	}
});

test("text matches words in any indexed column by prefix, phrases exactly, and never errors", async () => {
	const total = async (filter) => (await call("Email/query", { filter, limit: 0, calculateTotal: true })).total;
	const all = await total(null);
	const invoice = await total({ text: "invoice" });
	assert.ok(invoice > 0 && invoice < all);
	assert.equal(await total({ text: "INVOI" }), invoice, "prefix, case-insensitive");
	assert.equal(await total({ operator: "NOT", conditions: [{ text: "invoice" }] }), all - invoice, "NOT text is the complement");
	assert.ok((await total({ text: '"weekly sync"' })) > 0, "quoted phrase");
	assert.equal(await total({ text: '"sync weekly"' }), 0, "phrase order matters");
	assert.ok((await total({ text: "maya@acme.test" })) > 0, "address");
	assert.ok((await total({ text: "cc-person" })) > 0, "cc");
	assert.equal(await total({ text: "href" }), await total({ text: "link" }), "html bodies are indexed");
	assert.ok((await total({ text: "invoice", inMailbox: INBOX })) < invoice, "ANDs with other conditions");
	assert.equal(await total({ text: "voice" }), 0, "word prefix, not substring");

	const hostile = ['"', '""', '"abc', "-", "--", "*", "a*", ":", "subject:", "AND", "OR", "NOT", "NEAR", "NEAR(a b)", "(", "()", "{to_addr}", "{to_addr}: x", "^", "\\", "%", "_", "%_\\", "📎 会议", "x".repeat(10_000), "invoice ".repeat(1000), "a\nb\tc", "'; DROP TABLE messages; --", "-invoice", "!".repeat(100)];
	for (const text of hostile) {
		const result = await call("Email/query", { filter: { text }, limit: 5, calculateTotal: true });
		assert.equal(result.name, "Email/query", `${JSON.stringify(text.slice(0, 40))}: ${JSON.stringify(result)}`);
		assert.ok(Array.isArray(result.ids));
	}
	assert.equal(await total({ text: "-invoice" }), invoice, "a leading minus is part of the text, not an exclusion");
	assert.equal((await call("Email/query", { filter: { text: 42 } })).name, "Email/query", "a non-string text is read as text");
});

test("text with no letters or digits keeps the substring match within D1's LIKE limit", async () => {
	await db.insert(m.messages).values({
		id: "m_punct",
		userId: USER.id,
		mailboxId: MAILBOX,
		direction: "inbound",
		fromAddr: "x@example.org",
		toAddr: "me@example.test",
		subject: "Price :-) !!!",
		status: "received",
		createdAt: new Date(1_790_000_000_000),
	});
	const found = await call("Email/query", { filter: { text: ":-)" } });
	assert.deepEqual(found.ids, ["m_punct"]);
	const long = await call("Email/query", { filter: { text: "!".repeat(60) }, calculateTotal: true });
	assert.deepEqual([long.ids, long.total], [[], 0]);
	await db.delete(m.messages).where(m.eq(m.messages.id, "m_punct"));
});

test("pages and totals stop at QUERY_WINDOW on both paths", async () => {
	insertMessages(m.QUERY_WINDOW + 5, { prefix: "w", mailboxId: OTHER, start: 1_700_000_000, status: "archived" });
	const filter = { inMailbox: ref(OTHER, "archive") };
	const first = await call("Email/query", { filter, limit: 1, calculateTotal: true });
	assert.equal(first.total, m.QUERY_WINDOW);
	const last = await call("Email/query", { filter, position: m.QUERY_WINDOW - 10, limit: 50, calculateTotal: true });
	const fromEnd = await call("Email/query", { filter, position: -10, limit: 50, calculateTotal: true });
	assert.equal(last.ids.length, 10);
	assert.deepEqual([last.position, last.ids, last.total], [fromEnd.position, fromEnd.ids, fromEnd.total]);
	const past = await call("Email/query", { filter, position: m.QUERY_WINDOW, limit: 50 });
	assert.deepEqual(past.ids, []);
});
