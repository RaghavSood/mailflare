import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** public/v2-assets/offline.js as the page and the service worker load it. */
function loadOffline() {
	const self = { crypto: globalThis.crypto };
	vm.runInNewContext(readFileSync(join(root, "public/v2-assets/offline.js"), "utf8"), { self, FormData, URL, Promise, console });
	return self.MailflareOffline;
}
const Offline = loadOffline();
/** Values made in the sandbox have its prototypes; compare them as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const outDir = mkdtempSync(join(tmpdir(), "mailflare-offline-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	stdin: { contents: `export { resolveSnoozeTime } from "./src/lib/v2/data/time-utils.ts";`, resolveDir: root, sourcefile: "offline-test-entry.js" },
	bundle: true,
	format: "esm",
	platform: "neutral",
	outfile: join(outDir, "entry.mjs"),
	logLevel: "silent",
});
const server = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("only forward actions, drafts and sends can be queued", () => {
	const act = (fields) => Offline.queueKind("/v2/act", [["ids", "msg_1"], ...fields]);
	for (const action of ["archive", "trash", "spam", "inbox", "read", "unread", "star", "unstar"]) assert.equal(act([["action", action]]), "act", action);
	for (const move of ["inbox", "archive", "spam", "trash", "folder:fld_1"]) assert.equal(act([["move", move]]), "act", move);
	assert.equal(act([["snooze", "tomorrow"]]), "act");
	assert.equal(act([["action", "delete"]]), null, "unknown action");
	assert.equal(act([["move", "folder:<x>"]]), null, "malformed folder");
	assert.equal(Offline.queueKind("/v2/act", [["action", "archive"]]), null, "nothing selected");
	assert.equal(Offline.queueKind("/v2/undo", [["undo", "{}"]]), null, "undo depends on server state");
	assert.equal(Offline.queueKind("/v2/unread-from", [["messageId", "msg_1"]]), null);
	assert.equal(Offline.queueKind("/v2/reply", [["messageId", "msg_1"]]), null);
	assert.equal(Offline.queueKind("/v2/draft", [["to", "a@b.c"]]), "draft");
	assert.equal(Offline.queueKind("/v2/send", [["to", "a@b.c"]]), "send");
});

test("snooze presets are fixed to the time the server would have picked when they were chosen", () => {
	const original = process.env.TZ;
	try {
		for (const zone of ["Asia/Singapore", "America/New_York", "Europe/London"]) {
			process.env.TZ = zone;
			// A week of hours, crossing the US daylight-saving change.
			for (let hour = 0; hour < 24 * 8; hour += 5) {
				const now = new Date(Date.UTC(2026, 2, 5, 3, 17) + hour * 3600_000);
				for (const choice of ["later", "tomorrow", "weekend", "nextweek"]) {
					const stamp = Offline.resolveSnoozePreset(choice, now);
					assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
					const expected = server.resolveSnoozeTime(choice, null, zone, now);
					const replayed = server.resolveSnoozeTime("custom", stamp, zone, now);
					assert.equal(Math.floor(replayed.getTime() / 60000), Math.floor(expected.getTime() / 60000), `${zone} ${now.toISOString()} ${choice}`);
				}
			}
		}
	} finally {
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
	}
	assert.equal(Offline.resolveSnoozePreset("custom", new Date()), null);
});

test("queued fields drop page-only flags, resolve snoozes and keep only real attachments", () => {
	const now = new Date(2026, 9, 14, 10, 30);
	assert.deepEqual(
		plain(Offline.prepareFields("act", [["ids", "m1"], ["partial", "1"], ["snooze", "tomorrow"], ["snoozeAt", ""]], now)),
		[["ids", "m1"], ["snooze", "custom"], ["snoozeAt", "2026-10-15T08:00"]],
	);
	assert.deepEqual(plain(Offline.prepareFields("act", [["ids", "m1"], ["snooze", "custom"], ["snoozeAt", "2026-11-01T09:00"]], now)), [["ids", "m1"], ["snooze", "custom"], ["snoozeAt", "2026-11-01T09:00"]]);
	const file = new File(["x"], "a.txt");
	const empty = new File([], "");
	const send = Offline.prepareFields("send", [["to", "a@b.c"], ["attachments", empty], ["attachments", file]]);
	assert.equal(send.length, 2);
	assert.equal(send[1][1], file);
	assert.deepEqual(plain(Offline.prepareFields("draft", [["to", "a@b.c"], ["attachments", file]])), [["to", "a@b.c"]]);
});

test("a composer keeps one pending draft save, and sending it replaces that save", () => {
	const entry = (id, kind, key, createdAt) => ({ id, kind, key, createdAt, user: "u", fields: [] });
	let list = [];
	list = Offline.enqueue(list, entry("a1", "act", undefined, 1));
	list = Offline.enqueue(list, entry("d1", "draft", "k1", 2));
	list = Offline.enqueue(list, entry("d2", "draft", "k2", 3));
	list = Offline.enqueue(list, entry("d3", "draft", "k1", 4));
	assert.deepEqual(list.map((item) => item.id), ["a1", "d2", "d3"]);
	list = Offline.enqueue(list, entry("s1", "send", "k1", 5));
	assert.deepEqual(list.map((item) => item.id), ["a1", "d2", "s1"]);
	list = Offline.enqueue(list, entry("a0", "act", undefined, 0));
	assert.equal(list[0].id, "a0", "kept in the order the user acted");
});

test("cache rules: owners come from <body data-user>, and only v2 pages, bodies and attachments are kept", () => {
	assert.equal(Offline.userFromHtml(`<!doctype html><html><body hx-boost="true" data-user="usr_1">`), "usr_1");
	assert.equal(Offline.userFromHtml(`<!doctype html><html><body><div data-user="usr_1">`), null);
	assert.equal(Offline.markCached(`<html><body class="x">`, 1700000000000), `<html><body data-cached-at="1700000000000" class="x">`);
	const kind = (path) => Offline.cacheKind(new URL(path, "https://m.example"));
	assert.equal(kind("/v2/inbox"), "page");
	assert.equal(kind("/v2/inbox/msg_1"), "page");
	assert.equal(kind("/v2/compose"), "page");
	assert.equal(kind("/v2/compose/new"), null);
	assert.equal(kind("/v2/poll"), null);
	assert.equal(kind("/v2/act"), null);
	assert.equal(kind("/v2"), null);
	assert.equal(kind("/v2/body/msg_1"), "body");
	assert.equal(kind("/api/messages/msg_1/attachments/att_1"), "file");
	assert.equal(kind("/api/messages/msg_1/original"), null);
	assert.equal(Offline.userCacheName("usr/1"), "mf-user-usr%2F1");
	assert.ok(Offline.isUserCacheName("mf-user-x") && !Offline.isUserCacheName("mf-static-3-2.0.11"));
});

/** An in-memory outbox and a scripted server. */
function harness(entries, routes) {
	const store = new Map(entries.map((entry) => [entry.id, structuredClone(entry)]));
	const outbox = {
		all: async () => [...store.values()].map((entry) => structuredClone(entry)),
		put: async (entry) => void store.set(entry.id, structuredClone(entry)),
		delete: async (id) => void store.delete(id),
	};
	const calls = [];
	const fetch = async (path, init) => {
		assert.equal(init.redirect, "manual", "a replay never follows the redirect to a page");
		const fields = [...init.body].map(([key, value]) => [key, typeof value === "string" ? value : `file:${value.name}`]);
		calls.push({ path, user: init.headers["X-Mailflare-User"], fields });
		const route = routes[path];
		const reply = typeof route === "function" ? route(fields, calls) : route;
		if (reply === "offline") throw new TypeError("Failed to fetch");
		return reply instanceof Response ? reply : new Response(reply.body ?? null, { status: reply.status ?? 200, headers: reply.headers });
	};
	return { store, outbox, calls, fetch };
}

const entry = (id, kind, fields, extra = {}) => ({ id, kind, user: "usr_a", createdAt: Number(id.replace(/\D/g, "")), fields, ...extra });
const field = (call, name) => call.fields.find(([key]) => key === name)?.[1];

test("the outbox replays in order as the user who queued it, and keeps what could not be delivered", async () => {
	let online = true;
	const h = harness(
		[
			entry("e1", "act", [["ids", "m1"], ["action", "archive"]]),
			entry("e2", "act", [["ids", "m2"], ["action", "star"], ["conversation", "1"]]),
			entry("e3", "act", [["ids", "m3"], ["action", "trash"]]),
		],
		{ "/v2/act": () => (online ? { status: 200 } : "offline") },
	);
	const original = h.fetch;
	let count = 0;
	const fetch = async (path, init) => {
		count += 1;
		if (count === 3) online = false;
		return original(path, init);
	};
	const result = await Offline.drain(h.outbox, { fetch, user: "usr_a" });
	assert.deepEqual(h.calls.map((call) => field(call, "ids")), ["m1", "m2", "m3"]);
	assert.ok(h.calls.every((call) => call.user === "usr_a"), "the server can refuse another user's replay");
	assert.equal(field(h.calls[0], "partial"), "1");
	assert.equal(field(h.calls[1], "quiet"), "1", "conversation actions ask for no page back");
	assert.deepEqual({ sent: result.sent, remaining: result.remaining }, { sent: 2, remaining: 1 });
	assert.deepEqual([...h.store.keys()], ["e3"], "stopped at the first network failure, entry kept");
});

test("a refused entry is dropped with the server's reason; another user's entries are never sent", async () => {
	const h = harness(
		[
			entry("e1", "act", [["ids", "m1"], ["action", "archive"]], { user: "usr_b" }),
			entry("e2", "act", [["ids", "m2"], ["snooze", "custom"], ["snoozeAt", "2020-01-01T08:00"]]),
			entry("e3", "act", [["ids", "m3"], ["action", "read"]]),
		],
		{ "/v2/act": (fields) => (fields.some(([key]) => key === "snooze") ? { status: 422, body: "Pick a time in the future." } : { status: 204 }) },
	);
	const dropped = [];
	const result = await Offline.drain(h.outbox, { fetch: h.fetch, user: "usr_a", onDropped: (message) => dropped.push(message) });
	assert.deepEqual(h.calls.map((call) => field(call, "ids")), ["m2", "m3"]);
	assert.deepEqual(dropped, ["Pick a time in the future."]);
	assert.deepEqual({ sent: result.sent, dropped: result.dropped, remaining: result.remaining }, { sent: 1, dropped: 1, remaining: 0 });
	assert.deepEqual([...h.store.keys()], ["e1"], "left for adoptUser or sign-out to discard, not replayed");
});

test("a send saves the draft first, sends with its id, and never sends twice", async () => {
	const sends = [];
	const routes = {
		"/v2/draft": (fields) => (field({ fields }, "draftId") === "msg_gone" ? { status: 410, body: "{}" } : { body: JSON.stringify({ draftId: field({ fields }, "draftId") || "msg_new" }), headers: { "Content-Type": "application/json" } }),
		"/v2/send": (fields) => {
			sends.push(field({ fields }, "draftId"));
			return sends.length === 1 ? "offline" : { status: 303, headers: { Location: "/v2/inbox" } };
		},
	};
	const h = harness([entry("e1", "send", [["to", "a@b.c"], ["subject", "Hi"], ["draftId", ""], ["attachments", new File(["x"], "a.txt")]], { key: "k1" })], routes);
	// The first attempt saves the draft but loses the send.
	let result = await Offline.drain(h.outbox, { fetch: h.fetch, user: "usr_a" });
	assert.equal(result.remaining, 1);
	assert.equal(Offline.fieldValue(h.store.get("e1").fields, "draftId"), "msg_new", "the entry now names its server draft");
	result = await Offline.drain(h.outbox, { fetch: h.fetch, user: "usr_a" });
	assert.deepEqual(sends, ["msg_new", "msg_new"]);
	assert.deepEqual(h.calls.map((call) => call.path), ["/v2/draft", "/v2/send", "/v2/draft", "/v2/send"]);
	assert.equal(field(h.calls[1], "attachments"), "file:a.txt", "new attachments travel with the send");
	assert.equal(field(h.calls[0], "attachments"), undefined, "but not with the draft save");
	assert.equal(result.remaining, 0);

	// The draft is gone (sent by a replay whose response was lost): done, nothing sent.
	const gone = harness([entry("e2", "send", [["to", "a@b.c"], ["draftId", "msg_gone"]])], routes);
	result = await Offline.drain(gone.outbox, { fetch: gone.fetch, user: "usr_a" });
	assert.deepEqual(gone.calls.map((call) => call.path), ["/v2/draft"]);
	assert.equal(result.remaining, 0);

	// The server refuses to send a draft that no longer exists.
	const refused = harness([entry("e3", "send", [["to", "a@b.c"], ["draftId", "msg_1"]])], { ...routes, "/v2/send": { status: 410, body: "This message was already sent or its draft was discarded." } });
	result = await Offline.drain(refused.outbox, { fetch: refused.fetch, user: "usr_a" });
	assert.equal(result.dropped, 0, "410 means already sent, not a failure");
	assert.equal(refused.store.size, 0);
});

test("a queued draft save gives its composer's later entries the server draft id", async () => {
	const ids = [];
	const h = harness(
		[
			entry("e1", "draft", [["to", "a@b.c"], ["draftId", ""]], { key: "k1" }),
			entry("e2", "send", [["to", "a@b.c"], ["draftId", ""]], { key: "k1" }),
		],
		{
			"/v2/draft": (fields) => ({ body: JSON.stringify({ draftId: field({ fields }, "draftId") || "msg_d" }) }),
			"/v2/send": { status: 200 },
		},
	);
	await Offline.drain(h.outbox, { fetch: h.fetch, user: "usr_a", onDraftId: (key, id) => ids.push([key, id]) });
	assert.deepEqual(ids[0], ["k1", "msg_d"]);
	assert.deepEqual(h.calls.map((call) => [call.path, field(call, "draftId")]), [["/v2/draft", ""], ["/v2/draft", "msg_d"], ["/v2/send", "msg_d"]], "one draft, updated, then sent");
});

test("a signed-out replay stops and reports it, keeping nothing for anyone else", async () => {
	const h = harness([entry("e1", "act", [["ids", "m1"], ["action", "archive"]])], { "/v2/act": { status: 401 } });
	const result = await Offline.drain(h.outbox, { fetch: h.fetch, user: "usr_a" });
	assert.equal(result.signedOut, true);
	assert.equal(h.store.size, 1, "the page purges the outbox when it learns this");
	assert.deepEqual(plain(await Offline.drain(h.outbox, { fetch: h.fetch, user: "" })), { sent: 0, dropped: 0, remaining: 0, signedOut: false }, "no user, no replay");
});
