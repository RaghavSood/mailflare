/**
 * End-to-end check of JMAP Email/get against a running server, in the shapes
 * clients send: a metadata-only list fetch (what Apple Mail asks for), every
 * property with body values, the body structure, and a `header:` property.
 * It checks the answers are internally consistent (size is the bodies plus the
 * attachments, header values match their parsed forms) and times the list fetch.
 *
 *   npm run dev && npm run db:seed        # in another shell, then deliver some mail
 *   node scripts/jmap-get-check.mjs
 *
 * Pass a key with the `jmap` scope in JMAP_KEY, or let the script sign in with
 * the seeded demo account and mint one. BASE_URL overrides http://localhost:3000.
 * SAVE_FIXTURE=<file> writes the four Email/get responses; COMPARE_FIXTURE=<file>
 * fails unless they are identical to a saved run (compare a build before and
 * after a change on the same data). BENCH_RUNS sets the timed runs (default 10).
 */

import { readFileSync, writeFileSync } from "node:fs";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DEMO = { email: "admin@example.com", password: "demo-password-change-me" };
const BENCH_RUNS = Number(process.env.BENCH_RUNS ?? 10);
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

const LIST_PROPERTIES = ["id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt", "messageId", "inReplyTo", "references", "from", "to", "cc", "subject", "sentAt", "hasAttachment", "preview"];

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
	if (ok) {
		passed += 1;
		console.log(`  ok   ${name}`);
	} else {
		failed += 1;
		console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

async function mintKey() {
	if (process.env.JMAP_KEY) return process.env.JMAP_KEY;
	const login = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(DEMO),
	});
	if (!login.ok) throw new Error(`login failed (${login.status}); run npm run db:seed first`);
	const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
	const created = await fetch(`${BASE}/api/api-keys`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ name: `get-check ${Date.now()}`, scopes: ["jmap"] }),
	});
	if (!created.ok) throw new Error(`could not mint an API key (${created.status})`);
	return (await created.json()).key;
}

/** One JMAP request; returns the method responses and the response size in bytes. */
async function jmap(key, methodCalls) {
	const response = await fetch(`${BASE}/jmap/api`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({ using: USING, methodCalls }),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`JMAP ${response.status}: ${text.slice(0, 500)}`);
	return { responses: JSON.parse(text).methodResponses, bytes: Buffer.byteLength(text) };
}

function utf8Length(value) {
	return Buffer.byteLength(value ?? "", "utf8");
}

const key = await mintKey();
const session = await (await fetch(`${BASE}/jmap/session`, { headers: { Authorization: `Bearer ${key}` } })).json();
const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
if (!accountId) throw new Error("no mail account in the JMAP session");

section("Email/query (newest 200)");
const { responses: queried } = await jmap(key, [["Email/query", { accountId, sort: [{ property: "receivedAt", isAscending: false }], limit: 200 }, "q"]]);
const ids = queried[0][1].ids ?? [];
check("query returns ids", ids.length > 0, queried[0]);
// D1 binds at most 100 parameters per query; 90 ids stays under that even
// for a server that does not split the lookup.
const listIds = ids.slice(0, 90);
const bodyIds = ids.slice(0, 60);

const shapes = {
	list: ["Email/get", { accountId, ids: listIds, properties: LIST_PROPERTIES }, "list"],
	all: ["Email/get", { accountId, ids: bodyIds, properties: null, fetchAllBodyValues: true }, "all"],
	structure: ["Email/get", { accountId, ids: bodyIds, properties: ["id", "bodyStructure", "textBody", "htmlBody", "attachments", "size"] }, "structure"],
	header: ["Email/get", { accountId, ids: bodyIds, properties: ["id", "header:Message-ID:asText", "header:Message-ID:asMessageIds", "messageId", "header:Subject", "header:From:asAddresses"] }, "header"],
};

const results = {};
for (const [name, call] of Object.entries(shapes)) {
	const { responses } = await jmap(key, [call]);
	const [method, body] = responses[0];
	check(`${name}: Email/get answers`, method === "Email/get", responses[0]);
	results[name] = body;
}

section("Metadata list fetch");
const list = results.list.list ?? [];
check("every id is found", list.length === listIds.length && results.list.notFound?.length === 0, { found: list.length, notFound: results.list.notFound });
check("the list follows the requested order", list.map((item) => item.id).join(",") === listIds.join(","));
check("only the asked properties come back", list.every((item) => Object.keys(item).every((property) => property === "id" || LIST_PROPERTIES.includes(property))));
check("every asked property is present", list.every((item) => LIST_PROPERTIES.every((property) => property in item)));
// An empty message with no attachments really has size 0.
check("sizes are non-negative integers", list.every((item) => Number.isInteger(item.size) && item.size >= 0), list.find((item) => !(Number.isInteger(item.size) && item.size >= 0)));
check("previews are filled", list.every((item) => typeof item.preview === "string"));

section("Everything with body values");
const all = new Map((results.all.list ?? []).map((item) => [item.id, item]));
let sizeMismatch = null;
for (const item of all.values()) {
	const values = Object.values(item.bodyValues ?? {});
	const attachmentBytes = (item.attachments ?? []).reduce((total, part) => total + part.size, 0);
	const expected = values.reduce((total, value) => total + utf8Length(value.value), 0) + attachmentBytes;
	if (item.size !== expected) sizeMismatch ??= { id: item.id, size: item.size, expected };
}
check("size = UTF-8 bytes of the bodies + attachment sizes", !sizeMismatch, sizeMismatch);
const listById = new Map(list.map((item) => [item.id, item]));
check(
	"list fetch and full fetch agree on every shared property",
	Array.from(all.values()).every((item) => LIST_PROPERTIES.every((property) => JSON.stringify(item[property]) === JSON.stringify(listById.get(item.id)?.[property]))),
);
const emoji = Array.from(all.values()).find((item) => /🎉|東京|👋/u.test(JSON.stringify(item.bodyValues)));
check("a multibyte body is among them", !!emoji, "deliver mail with emoji/CJK text first");
if (emoji) {
	const text = emoji.bodyValues[emoji.textBody[0].partId]?.value ?? "";
	check("multibyte part size is its UTF-8 byte length", emoji.textBody[0].size === utf8Length(text), { size: emoji.textBody[0].size, bytes: utf8Length(text), chars: text.length });
	check("multibyte part size differs from its UTF-16 length", emoji.textBody[0].size !== text.length);
}
const withAttachment = Array.from(all.values()).find((item) => item.hasAttachment);
check("a message with attachments is among them", !!withAttachment, "deliver mail with attachments first");
if (withAttachment) check("its attachments carry blob ids and sizes", withAttachment.attachments.every((part) => part.blobId && part.size > 0));

section("Body structure");
const structure = new Map((results.structure.list ?? []).map((item) => [item.id, item]));
check(
	"structure fetch matches the full fetch",
	Array.from(structure.values()).every((item) => ["bodyStructure", "textBody", "htmlBody", "attachments", "size"].every((property) => JSON.stringify(item[property]) === JSON.stringify(all.get(item.id)?.[property]))),
);

section("Header properties");
const header = results.header.list ?? [];
check(
	"header:Message-ID:asText is the bracketed messageId",
	header.every((item) => (item.messageId ? item["header:Message-ID:asText"]?.replace(/^<|>$/g, "") === item.messageId[0] : item["header:Message-ID:asText"] == null)),
	header.find((item) => item.messageId && item["header:Message-ID:asText"]?.replace(/^<|>$/g, "") !== item.messageId[0]),
);
check("header:Message-ID:asMessageIds matches messageId", header.every((item) => JSON.stringify(item["header:Message-ID:asMessageIds"] ?? null) === JSON.stringify(item.messageId)));
check("header:Subject is the raw form (leading space)", header.every((item) => item["header:Subject"] == null || item["header:Subject"].startsWith(" ")));

section(`Metadata list fetch of all ${ids.length} ids (maxObjectsInGet is 200)`);
const full = await jmap(key, [["Email/get", { accountId, ids, properties: LIST_PROPERTIES }, "list200"]]);
const [fullMethod, fullBody] = full.responses[0];
check(`${ids.length}-id Email/get answers`, fullMethod === "Email/get" && fullBody.list?.length === ids.length, fullMethod === "Email/get" ? { found: fullBody.list?.length } : fullBody);
const listJson = new Map(list.map((item) => [item.id, JSON.stringify(item)]));
check("it agrees with the 90-id fetch", fullMethod === "Email/get" && fullBody.list.every((item) => !listJson.has(item.id) || listJson.get(item.id) === JSON.stringify(item)));

if (process.env.SAVE_FIXTURE) {
	writeFileSync(process.env.SAVE_FIXTURE, JSON.stringify(results, null, "\t"));
	console.log(`\nSaved the responses to ${process.env.SAVE_FIXTURE}`);
}
if (process.env.COMPARE_FIXTURE) {
	section(`Compared with ${process.env.COMPARE_FIXTURE}`);
	const saved = JSON.parse(readFileSync(process.env.COMPARE_FIXTURE, "utf8"));
	// List order is compared apart: a server is free to answer in any order, and
	// this one now follows the requested ids, which an older build did not.
	const byId = (body) => JSON.stringify({ ...body, list: [...(body.list ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1)) });
	for (const name of Object.keys(shapes)) {
		check(`${name}: identical response, list order aside`, byId(saved[name]) === byId(results[name]), "diff the two files");
		const order = (body) => (body.list ?? []).map((item) => item.id).join(",");
		console.log(`       list order ${order(saved[name]) === order(results[name]) ? "also identical" : "differs"}`);
	}
}

async function bench(label, call) {
	const times = [];
	let bytes = 0;
	for (let run = 0; run < BENCH_RUNS; run += 1) {
		const started = performance.now();
		const { responses, ...rest } = await jmap(key, [call]);
		times.push(performance.now() - started);
		bytes = rest.bytes;
		if (responses[0][0] !== "Email/get") {
			console.log(`  ${label}: ${responses[0][1].type}, not timed`);
			return;
		}
	}
	times.sort((a, b) => a - b);
	const median = times[Math.floor(times.length / 2)];
	const mean = times.reduce((total, value) => total + value, 0) / times.length;
	console.log(`  ${label}: median ${median.toFixed(1)} ms, mean ${mean.toFixed(1)} ms, min ${times[0].toFixed(1)} ms, max ${times[times.length - 1].toFixed(1)} ms, response ${bytes} bytes`);
}

section(`Timing, ${BENCH_RUNS} runs each`);
await bench(`${listIds.length}-id metadata Email/get`, shapes.list);
await bench(`${ids.length}-id metadata Email/get`, ["Email/get", { accountId, ids, properties: LIST_PROPERTIES }, "list200"]);
await bench(`${bodyIds.length}-id Email/get, all properties and body values`, shapes.all);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
