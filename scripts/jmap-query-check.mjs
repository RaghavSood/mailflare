/**
 * End-to-end check of JMAP Email/query paging and the `text` filter against a
 * running server.
 *
 *   node scripts/jmap-query-check.mjs                    # consistency + text checks
 *   DUMP=before.json node scripts/jmap-query-check.mjs   # also write the result matrix
 *   COMPARE=before.json node scripts/jmap-query-check.mjs  # also compare the matrix with a dump
 *   BENCH=10 node scripts/jmap-query-check.mjs           # also time page 1 / position 1000
 *
 * The matrix (filters x sorts x pages, Email/queryChanges from a recent state)
 * is read-only, so a dump taken on one build can be compared with another
 * build over the same database. The checks need a mailbox with a few hundred
 * messages in Inbox and Sent to be meaningful; the seeded demo data alone
 * exercises the shapes but not deep pages.
 *
 * Pass a key with the `jmap` scope in JMAP_KEY, or let the script sign in with
 * the seeded demo account and mint one. BASE_URL overrides http://localhost:3000.
 */
import { readFileSync, writeFileSync } from "node:fs";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DEMO = { email: "admin@example.com", password: "demo-password-change-me" };
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const MAX_LIMIT = 250;

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
	if (ok) {
		passed += 1;
		console.log(`  ok   ${name}`);
	} else {
		failed += 1;
		console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
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
		body: JSON.stringify({ name: `query-check ${Date.now()}`, scopes: ["jmap"] }),
	});
	if (!created.ok) throw new Error(`could not mint an API key (${created.status})`);
	return (await created.json()).key;
}

/** One JMAP request; returns the HTTP status and the method responses. */
async function jmapRaw(key, methodCalls) {
	const response = await fetch(`${BASE}/jmap/api`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({ using: USING, methodCalls }),
	});
	const text = await response.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		// Reported below with the status.
	}
	return { status: response.status, body, text };
}

async function jmap(key, methodCalls) {
	const { status, body, text } = await jmapRaw(key, methodCalls);
	if (status !== 200 || !body) throw new Error(`JMAP ${status}: ${text.slice(0, 300)}`);
	return body.methodResponses;
}

/** Many calls, batched under maxCallsInRequest; returns [name, result] per call, in order. */
async function callMany(key, calls) {
	const out = [];
	for (let i = 0; i < calls.length; i += 30) {
		const batch = calls.slice(i, i + 30).map(([name, args], index) => [name, args, `c${i + index}`]);
		const responses = await jmap(key, batch);
		for (const [name, result] of responses) out.push([name, result]);
	}
	return out;
}

async function callOne(key, name, args) {
	const [[responseName, result]] = await jmap(key, [[name, args, "c0"]]);
	return { name: responseName, ...result };
}

/**
 * The full ordered list a filter and sort describe, read through negative
 * positions: those always take the materialising path, so this is the
 * reference order every fast-path page must be a slice of.
 */
async function fullList(key, accountId, filter, sort) {
	const head = await callOne(key, "Email/query", { accountId, filter, sort, position: -1, limit: 1, calculateTotal: true });
	const total = head.total;
	const ids = [];
	for (let start = 0; start < total; start += MAX_LIMIT) {
		const page = await callOne(key, "Email/query", { accountId, filter, sort, position: start - total, limit: MAX_LIMIT });
		ids.push(...page.ids);
	}
	return { total, ids };
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function timeCall(key, methodCalls, runs) {
	const times = [];
	for (let i = 0; i < runs; i++) {
		const started = performance.now();
		await jmap(key, methodCalls);
		times.push(performance.now() - started);
	}
	return median(times);
}

async function main() {
	const key = await mintKey();
	const session = await (await fetch(`${BASE}/jmap/session`, { headers: { Authorization: `Bearer ${key}` } })).json();
	const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];

	const mailboxes = (await callOne(key, "Mailbox/get", { accountId, ids: null })).list;
	const byRole = (role) => mailboxes.filter((box) => box.role === role).sort((a, b) => b.totalEmails - a.totalEmails)[0];
	const inbox = byRole("inbox");
	const sent = byRole("sent");
	const archive = byRole("archive");
	const drafts = byRole("drafts");
	const owner = inbox.id.split("~")[0];
	const account = mailboxes.find((box) => box.id === owner);
	const folder = mailboxes.filter((box) => box.id.startsWith(`${owner}~f~`)).sort((a, b) => b.totalEmails - a.totalEmails)[0];
	section("Mailboxes");
	console.log(`  inbox ${inbox.totalEmails}, sent ${sent.totalEmails}, folder ${folder?.totalEmails ?? "none"}, account ${account?.totalEmails ?? "none"}`);

	const filters = {
		none: null,
		inbox: { inMailbox: inbox.id },
		sent: { inMailbox: sent.id },
		archive: { inMailbox: archive.id },
		drafts: { inMailbox: drafts.id },
		...(folder ? { folder: { inMailbox: folder.id } } : {}),
		...(account ? { account: { inMailbox: account.id } } : {}),
		inboxUnread: { inMailbox: inbox.id, notKeyword: "$seen" },
		inboxFlagged: { inMailbox: inbox.id, hasKeyword: "$flagged" },
		fromMaya: { inMailbox: inbox.id, from: "maya" },
		subject: { subject: "invoice" },
		after: { inMailbox: inbox.id, after: "2026-06-01T00:00:00Z" },
		or: { operator: "OR", conditions: [{ inMailbox: inbox.id }, { inMailbox: sent.id }] },
		not: { operator: "NOT", conditions: [{ inMailbox: inbox.id }] },
	};
	const sorts = {
		default: undefined,
		receivedDesc: [{ property: "receivedAt", isAscending: false }],
		receivedAsc: [{ property: "receivedAt", isAscending: true }],
		subjectAsc: [{ property: "subject", isAscending: true }],
		fromDesc: [{ property: "from", isAscending: false }],
		sizeDesc: [{ property: "size", isAscending: false }],
		seenThenDate: [{ property: "hasKeyword", keyword: "$seen", isAscending: true }, { property: "receivedAt", isAscending: false }],
	};
	const pages = {
		first: { position: 0, limit: 30, calculateTotal: true },
		firstNoTotal: { position: 0, limit: 30 },
		noLimit: {},
		second: { position: 30, limit: 30 },
		deep: { position: 1000, limit: 50, calculateTotal: true },
		tail: { position: 2390, limit: 50 },
		pastEnd: { position: 50000, limit: 10, calculateTotal: true },
		zero: { position: 0, limit: 0, calculateTotal: true },
		negative: { position: -10, limit: 20, calculateTotal: true },
		fraction: { position: 1.5, limit: 3 },
		stringPosition: { position: "5", limit: "4" },
		nonsense: { position: "x", limit: 5 },
		collapsed: { position: 10, limit: 40, collapseThreads: true, calculateTotal: true },
		collapsedFalse: { position: 10, limit: 40, collapseThreads: false, calculateTotal: true },
	};

	const matrixCalls = [];
	const matrixKeys = [];
	for (const [fName, filter] of Object.entries(filters)) {
		for (const [sName, sort] of Object.entries(sorts)) {
			for (const [pName, page] of Object.entries(pages)) {
				matrixKeys.push(`${fName}/${sName}/${pName}`);
				matrixCalls.push(["Email/query", { accountId, filter, sort, ...page }]);
			}
		}
	}

	section(`Fast-path pages are slices of the materialised order (${Object.keys(filters).length} filters x ${Object.keys(sorts).length} sorts)`);
	const answers = await callMany(key, matrixCalls);
	const results = Object.fromEntries(matrixKeys.map((name, index) => [name, answers[index]]));
	let sliceMismatches = 0;
	let compared = 0;
	for (const [fName, filter] of Object.entries(filters)) {
		for (const [sName, sort] of Object.entries(sorts)) {
			const full = await fullList(key, accountId, filter, sort);
			for (const [pName, page] of Object.entries(pages)) {
				if (page.collapseThreads || pName === "negative" || pName === "nonsense" || pName === "fraction") continue;
				const [name, result] = results[`${fName}/${sName}/${pName}`];
				const position = Number(page.position ?? 0);
				const limit = Math.min(Number(page.limit ?? MAX_LIMIT), MAX_LIMIT);
				const expected = full.ids.slice(position, position + limit);
				compared += 1;
				const same =
					name === "Email/query" &&
					result.position === position &&
					JSON.stringify(result.ids) === JSON.stringify(expected) &&
					(page.calculateTotal ? result.total === full.total : result.total === undefined);
				if (!same) {
					sliceMismatches += 1;
					if (sliceMismatches <= 5) check(`${fName}/${sName}/${pName}`, false, { got: result, expected: { position, ids: expected, total: full.total } });
				}
			}
		}
	}
	check(`${compared} pages match their slice, position and total`, sliceMismatches === 0, `${sliceMismatches} mismatches`);

	section("Anchors and collapseThreads keep the materialising path");
	const inboxFull = await fullList(key, accountId, filters.inbox, undefined);
	const anchored = await callOne(key, "Email/query", { accountId, filter: filters.inbox, anchor: inboxFull.ids[100], anchorOffset: -5, limit: 10 });
	check("anchor resolves to its index plus offset", anchored.position === 95 && JSON.stringify(anchored.ids) === JSON.stringify(inboxFull.ids.slice(95, 105)), anchored);
	const missing = await callOne(key, "Email/query", { accountId, filter: filters.inbox, anchor: "msg_does_not_exist" });
	check("an unknown anchor is anchorNotFound", missing.type === "anchorNotFound", missing);

	// Email/queryChanges from a recent state: read-only, so it belongs in the matrix too.
	const state = Number((await callOne(key, "Email/query", { accountId, limit: 0 })).queryState);
	const sinceQueryState = String(Math.max(state - 25, 0));
	const changeCalls = [];
	const changeKeys = [];
	for (const [fName, filter] of Object.entries({ none: null, inbox: filters.inbox, sent: filters.sent, inboxUnread: filters.inboxUnread })) {
		for (const collapseThreads of [false, true]) {
			for (const sName of ["default", "receivedAsc", "subjectAsc"]) {
				changeKeys.push(`queryChanges/${fName}/${sName}/${collapseThreads ? "collapsed" : "flat"}`);
				changeCalls.push(["Email/queryChanges", { accountId, filter, sort: sorts[sName], collapseThreads, sinceQueryState, calculateTotal: true }]);
			}
		}
	}
	const changeAnswers = await callMany(key, changeCalls);
	changeKeys.forEach((name, index) => (results[name] = changeAnswers[index]));

	section("Email/queryChanges indexes agree with Email/query positions");
	const changes = Object.fromEntries(changeKeys.map((name, index) => [name, changeAnswers[index]]));
	const inboxChange = changes["queryChanges/inbox/default/flat"][1];
	check("queryChanges answers", Array.isArray(inboxChange.added), inboxChange);
	const misplaced = (inboxChange.added ?? []).filter(({ id, index }) => inboxFull.ids[index] !== id);
	check(`${inboxChange.added?.length ?? 0} added entries sit at their Email/query index`, misplaced.length === 0, misplaced.slice(0, 3));
	check("queryChanges total equals Email/query total", inboxChange.total === inboxFull.total, { changes: inboxChange.total, query: inboxFull.total });

	section("text filter");
	const textCases = [
		["a plain word", "invoice"],
		["a prefix", "invoi"],
		["two words", "quarterly report"],
		["a quoted phrase", '"weekly sync"'],
		["an address", "maya@acme.test"],
		["a display name", "Sam Okoro"],
		["punctuation only", "!!!"],
		["a lone quote", '"'],
		["unbalanced quote", '"invoice'],
		["a star", "*"],
		["a leading minus", "-invoice"],
		["a hyphen", "re-send"],
		["a column prefix", "subject:invoice"],
		["FTS operators", "invoice AND OR NOT NEAR"],
		["NEAR()", "NEAR(invoice budget)"],
		["parentheses", "(invoice"],
		["braces", "{to_addr}: invoice"],
		["caret", "^invoice"],
		["LIKE wildcards", "%_\\"],
		["SQL", "'; DROP TABLE messages; --"],
		["emoji and CJK", "📎 会议"],
		["whitespace", " \t\n "],
		["a long string", "invoice ".repeat(800)],
	];
	const textAnswers = await callMany(
		key,
		textCases.map(([, text]) => ["Email/query", { accountId, filter: { inMailbox: inbox.id, text }, limit: 5, calculateTotal: true }]),
	);
	textCases.forEach(([label, text], index) => {
		const [name, result] = textAnswers[index];
		check(`${label} (${JSON.stringify(text.slice(0, 30))}) → ${name === "Email/query" ? `${result.total} matches` : result.type}`, name === "Email/query" && Array.isArray(result.ids), result);
	});
	const totals = Object.fromEntries(textCases.map(([label], index) => [label, textAnswers[index][1].total]));
	check("a plain word finds mail", totals["a plain word"] > 0);
	check("a prefix finds the same mail as the word", totals["a prefix"] === totals["a plain word"], totals);
	check("a quoted phrase finds mail", totals["a quoted phrase"] > 0);
	check("an address finds mail", totals["an address"] > 0);
	const notWord = await callOne(key, "Email/query", { accountId, filter: { operator: "NOT", conditions: [{ text: "invoice" }] }, limit: 0, calculateTotal: true });
	const all = await callOne(key, "Email/query", { accountId, limit: 0, calculateTotal: true });
	const word = await callOne(key, "Email/query", { accountId, filter: { text: "invoice" }, limit: 0, calculateTotal: true });
	check("NOT text is the complement of text", notWord.total + word.total === all.total, { not: notWord.total, word: word.total, all: all.total });
	const both = await callOne(key, "Email/query", { accountId, filter: { text: "invoice", from: "maya" }, limit: 0, calculateTotal: true });
	check("text ANDs with other conditions", both.total > 0 && both.total < word.total, { both: both.total, word: word.total });
	results.text = Object.fromEntries(textCases.map(([label], index) => [label, textAnswers[index]]));

	if (process.env.DUMP) {
		writeFileSync(process.env.DUMP, JSON.stringify({ state, results }, null, "\t"));
		console.log(`\n  wrote ${Object.keys(results).length} results to ${process.env.DUMP}`);
	}
	if (process.env.COMPARE) {
		section(`Same answers as ${process.env.COMPARE}`);
		const before = JSON.parse(readFileSync(process.env.COMPARE, "utf8"));
		check("the database has not moved since the dump", before.state === state, { dump: before.state, now: state });
		const names = Object.keys(before.results).filter((name) => name !== "text");
		const differing = names.filter((name) => JSON.stringify(before.results[name]) !== JSON.stringify(results[name]));
		for (const name of differing.slice(0, 5)) check(name, false, { before: before.results[name], after: results[name] });
		check(`${names.length} results identical (ids, order, position, total, queryChanges)`, differing.length === 0, `${differing.length} differ`);
		// The text filter changed matching on purpose (FTS tokens, not substrings): report, do not fail.
		for (const [label, [name, result]] of Object.entries(before.results.text ?? {})) {
			const [afterName, after] = results.text[label] ?? [];
			const describe = (n, r) => (n === "Email/query" ? `${r.total}` : `${n}:${r.type}`);
			console.log(`  text ${label.padEnd(20)} before ${describe(name, result).padEnd(22)} after ${describe(afterName, after)}`);
		}
	}

	if (process.env.BENCH) {
		const runs = Number(process.env.BENCH) || 10;
		section(`Timings (median of ${runs}, ms per request)`);
		const shapes = [
			["Inbox page 1", { filter: filters.inbox, position: 0, limit: 50, calculateTotal: true }],
			["Inbox position 1000", { filter: filters.inbox, position: 1000, limit: 50, calculateTotal: true }],
			["Sent page 1", { filter: filters.sent, position: 0, limit: 50, calculateTotal: true }],
			["Sent position 1000", { filter: filters.sent, position: 1000, limit: 50, calculateTotal: true }],
			["Inbox page 1, no total", { filter: filters.inbox, position: 0, limit: 50 }],
			["no filter page 1", { position: 0, limit: 50, calculateTotal: true }],
			["text 'invoice' in Inbox", { filter: { inMailbox: inbox.id, text: "invoice" }, position: 0, limit: 50, calculateTotal: true }],
			["text 'maya@acme.test' anywhere", { filter: { text: "maya@acme.test" }, position: 0, limit: 50, calculateTotal: true }],
		];
		// The floor every request pays (API-key check, routing, session state), whatever the method.
		await timeCall(key, [["Core/echo", {}, "w"]], 2);
		console.log(`  ${"Core/echo (request floor)".padEnd(32)} ${(await timeCall(key, [["Core/echo", {}, "t"]], runs)).toFixed(1)}`);
		for (const [label, args] of shapes) {
			await timeCall(key, [["Email/query", { accountId, ...args }, "w"]], 2);
			const ms = await timeCall(key, [["Email/query", { accountId, ...args }, "t"]], runs);
			console.log(`  ${label.padEnd(32)} ${ms.toFixed(1)}`);
		}
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(`\nAborted: ${error.message}`);
	process.exit(1);
});
