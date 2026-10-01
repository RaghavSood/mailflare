import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The v2 interface's pure pieces: escaping, routing, action rules, compose helpers, time. */
const outDir = mkdtempSync(join(tmpdir(), "mailflare-v2-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { html, raw, escapeHtml } from "./src/lib/v2/html.ts";
			export { parseV2Path, listHref, threadHref, v2ToClassic, classicToV2, safeReturnPath } from "./src/lib/v2/paths.ts";
			export { neutralizeEmailHtml, buildMailFrameDocument, plainTextToHtml, resolveContentIds } from "./src/lib/v2/render/mail-frame.ts";
			export { buildParticipants, chunk, summaryView, memberInView } from "./src/lib/v2/data/list-utils.ts";
			export { pickActionTargets, parseUndoEntries } from "./src/lib/v2/data/thread-utils.ts";
			export { buildReplyRecipients, replySubject, buildQuoteHtml, htmlToMailText, parseFromValue } from "./src/lib/v2/data/compose-utils.ts";
			export { zonedTime, resolveSnoozeTime } from "./src/lib/v2/data/time-utils.ts";
			export { formatListDate, initials, recipientSummary, resolveTimeZone } from "./src/lib/v2/render/format.ts";
			export { homePathFor } from "./src/lib/v2/preference.ts";
		`,
		resolveDir: root,
		sourcefile: "v2-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const v2 = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("templates escape every interpolated value unless it is already HTML", () => {
	const name = `<img src=x onerror="alert(1)">'&`;
	const out = String(v2.html`<p title="${name}">${name}${v2.html`<b>ok</b>`}${["<i>", v2.raw("<br>")]}${null}${false}${0}</p>`);
	assert.equal(out, `<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;<b>ok</b>&lt;i&gt;<br>0</p>`);
});

test("v2 paths parse views, folders and conversations, and reject anything else", () => {
	assert.deepEqual(v2.parseV2Path("/v2"), { kind: "home" });
	assert.deepEqual(v2.parseV2Path("/v2/inbox"), { kind: "view", view: "inbox", folderId: null, messageId: null });
	assert.deepEqual(v2.parseV2Path("/v2/inbox/msg_abc-1/"), { kind: "view", view: "inbox", folderId: null, messageId: "msg_abc-1" });
	assert.deepEqual(v2.parseV2Path("/v2/folder/fld_1/msg_2"), { kind: "view", view: "folder", folderId: "fld_1", messageId: "msg_2" });
	assert.deepEqual(v2.parseV2Path("/v2/inbox/a/b"), { kind: "notFound" });
	assert.deepEqual(v2.parseV2Path("/v2/inbox/<script>"), { kind: "notFound" });
	assert.deepEqual(v2.parseV2Path("/v2/folder"), { kind: "notFound" });
	assert.deepEqual(v2.parseV2Path("/v2/draft/discard"), { kind: "action", name: "draft/discard" });
	assert.equal(v2.listHref("inbox", { q: "from:bob", page: 2 }), "/v2/inbox?q=from%3Abob&page=2");
	assert.equal(v2.listHref("inbox", { page: 1 }), "/v2/inbox");
	assert.equal(v2.threadHref("folder", "m1", { folderId: "f1", i: 0 }), "/v2/folder/f1/m1");
	assert.equal(v2.threadHref("search", "m1", { q: "x", i: 3 }), "/v2/search/m1?q=x&i=3");
});

test("the interface toggle lands on the same place in the other UI", () => {
	assert.equal(v2.v2ToClassic("/v2/inbox/msg_1"), "/inbox/msg_1");
	assert.equal(v2.v2ToClassic("/v2/archive"), "/archived");
	assert.equal(v2.v2ToClassic("/v2/folder/fld_1"), "/folders/fld_1");
	assert.equal(v2.v2ToClassic("/v2/all/msg_1"), "/inbox");
	assert.equal(v2.v2ToClassic("/v2/send"), "/inbox");
	assert.equal(v2.classicToV2("/archived/msg_9"), "/v2/archive/msg_9");
	assert.equal(v2.classicToV2("/folders/fld_1"), "/v2/folder/fld_1");
	assert.equal(v2.classicToV2("/settings/account"), "/v2/inbox");
	assert.equal(v2.classicToV2("/inbox"), "/v2/inbox");
	assert.equal(v2.homePathFor("v2"), "/v2/inbox");
	assert.equal(v2.homePathFor("classic"), "/inbox");
	assert.equal(v2.homePathFor(undefined), "/inbox");
});

test("post-action destinations stay inside /v2", () => {
	assert.equal(v2.safeReturnPath("/v2/inbox?q=a"), "/v2/inbox?q=a");
	for (const bad of ["https://evil.example/v2/", "//evil.example", "/inbox", "/v2", "/v2/\\evil", "/v2/x\r\nSet-Cookie: a=b", null, ""]) {
		assert.equal(v2.safeReturnPath(bad), "/v2/inbox", String(bad));
	}
});

test("email HTML loses active tags before it reaches the sandboxed frame", () => {
	const dirty = `<META http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/"><script>alert(1)</script><iframe src=x></iframe><form action=x><p>Hi</p></form><scripted>ok</scripted>`;
	const clean = v2.neutralizeEmailHtml(dirty);
	assert.doesNotMatch(clean, /<(meta|base|script|iframe|form)[\s>]/i);
	assert.match(clean, /<x-blocked-META http-equiv/);
	assert.match(clean, /<scripted>ok<\/scripted>/);
	const doc = v2.buildMailFrameDocument("<p>Hi</p>");
	assert.match(doc, /^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
	assert.match(doc, /<base target="_blank">/);
	assert.equal(
		v2.resolveContentIds(`<img src="cid:logo@x">`, "msg_1", [{ id: "att_1", contentId: "<logo@x>" }]),
		`<img src="/api/messages/msg_1/attachments/att_1">`,
	);
});

test("plain-text bodies are escaped and only web links become anchors", () => {
	const out = v2.plainTextToHtml(`<b>hi</b> see https://example.com/a?b=1&c=2. and javascript:alert(1)`);
	assert.equal(out, `&lt;b&gt;hi&lt;/b&gt; see <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">https://example.com/a?b=1&amp;c=2</a>. and javascript:alert(1)`);
});

test("conversation rows name senders in speaking order, 'me' for your own mail", () => {
	const at = (minutes) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
	const nameFor = (address) => address.split("@")[0];
	const members = [
		{ fromAddr: "alice@x.com", direction: "inbound", read: true, createdAt: at(1) },
		{ fromAddr: "me@y.com", direction: "outbound", read: true, createdAt: at(2) },
		{ fromAddr: "alice@x.com", direction: "inbound", read: false, createdAt: at(3) },
	];
	assert.deepEqual(v2.buildParticipants(members, { view: "inbox", nameFor, toAddr: "" }), [
		{ name: "me", unread: false },
		{ name: "alice", unread: true },
	]);
	assert.deepEqual(v2.buildParticipants([], { view: "sent", nameFor, toAddr: "Bob <bob@z.com>, carol@z.com" }), [{ name: "To: bob, carol", unread: false }]);
	const many = ["a", "b", "c", "d", "e"].map((name, index) => ({ fromAddr: `${name}@x.com`, direction: "inbound", read: true, createdAt: at(index) }));
	assert.deepEqual(v2.buildParticipants(many, { view: "inbox", nameFor, toAddr: "" }).map((item) => item.name), ["a", "d", "e"]);
	assert.deepEqual(v2.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("actions only touch the messages they make sense for", () => {
	const at = (minutes) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
	const candidates = [
		{ id: "in1", key: "t", direction: "inbound", status: "received", folderId: null, read: true, starred: false, createdAt: at(1) },
		{ id: "out", key: "t", direction: "outbound", status: "sent", folderId: null, read: true, starred: false, createdAt: at(2) },
		{ id: "in2", key: "t", direction: "inbound", status: "received", folderId: "f", read: false, starred: false, createdAt: at(3) },
		{ id: "arc", key: "t", direction: "inbound", status: "archived", folderId: null, read: true, starred: false, createdAt: at(0) },
	];
	const ids = (action) => v2.pickActionTargets(candidates, action, "inbox").map((item) => item.id).sort();
	assert.deepEqual(ids("archive"), ["in1", "in2"]);
	assert.deepEqual(ids("trash"), ["arc", "in1", "in2", "out"]);
	assert.deepEqual(ids("spam"), ["arc", "in1", "in2"]);
	assert.deepEqual(ids("inbox"), ["arc", "in2"]);
	assert.deepEqual(ids("read"), ["in2"]);
	// Unread marks the newest received message, and only if it is read.
	assert.deepEqual(ids("unread"), []);
	assert.deepEqual(v2.pickActionTargets(candidates.slice(0, 2), "unread", "inbox").map((item) => item.id), ["in1"]);
	assert.deepEqual(v2.pickActionTargets(candidates, "folder", "drafts"), []);
});

test("undo data from the browser is validated before anything is restored", () => {
	const good = { id: "msg_1", status: "received", folderId: null, read: true };
	assert.deepEqual(v2.parseUndoEntries(JSON.stringify([good, { ...good, id: "x'; drop" }, { ...good, status: "owned" }, { ...good, read: "yes" }, { ...good, folderId: "fld_1" }])), [good, { ...good, folderId: "fld_1" }]);
	assert.deepEqual(v2.parseUndoEntries("not json"), []);
	assert.deepEqual(v2.parseUndoEntries(JSON.stringify({ id: "msg_1" })), []);
});

test("replies address the right people and quote the original as escaped text", () => {
	const inbound = { direction: "inbound", fromAddr: "Alice <alice@x.com>", toAddr: "me@y.com, Bob <bob@x.com>", ccAddr: "carol@x.com, ALIAS@y.com" };
	const own = ["me@y.com", "alias@y.com"];
	assert.deepEqual(v2.buildReplyRecipients(inbound, "reply", own), { to: ["Alice <alice@x.com>"], cc: [] });
	assert.deepEqual(v2.buildReplyRecipients(inbound, "all", own), { to: ["Alice <alice@x.com>"], cc: ["Bob <bob@x.com>", "carol@x.com"] });
	assert.deepEqual(v2.buildReplyRecipients(inbound, "forward", own), { to: [], cc: [] });
	const outbound = { direction: "outbound", fromAddr: "me@y.com", toAddr: "bob@x.com", ccAddr: "carol@x.com" };
	assert.deepEqual(v2.buildReplyRecipients(outbound, "all", own), { to: ["bob@x.com"], cc: ["carol@x.com"] });
	assert.equal(v2.replySubject("Hello", "reply"), "Re: Hello");
	assert.equal(v2.replySubject("RE: Hello", "reply"), "RE: Hello");
	assert.equal(v2.replySubject("Hello", "forward"), "Fwd: Hello");
	assert.equal(v2.replySubject(null, "forward"), "Fwd:");
	const quote = v2.buildQuoteHtml(
		{ ...inbound, subject: "S", createdAt: new Date(0), textBody: null, htmlBody: `<p>Hi <img src=x onerror=alert(1)></p><script>bad()</script>` },
		"reply",
		() => "Jan 1",
	);
	assert.doesNotMatch(quote, /<img|<script|onerror=alert/);
	assert.match(quote, /^<div>On Jan 1, Alice &lt;alice@x.com&gt; wrote:<\/div><blockquote/);
	assert.match(v2.buildQuoteHtml({ ...inbound, subject: "S", createdAt: new Date(0), textBody: "Body", htmlBody: null }, "forward", () => "Jan 1"), /Forwarded message/);
});

test("text parts keep paragraphs and mark quotes", () => {
	assert.equal(v2.htmlToMailText(`<div>Hello</div><div>there &amp; you</div><blockquote>old<br>line</blockquote><ul><li>a</li></ul>`), "Hello\nthere & you\n> old\n> line\n- a");
	assert.deepEqual(v2.parseFromValue("mbx_1|Alias@Y.com"), { mailboxId: "mbx_1", address: "alias@y.com" });
	assert.equal(v2.parseFromValue("bad id|a@b.c"), null);
	assert.equal(v2.parseFromValue("mbx_1"), null);
});

test("snooze times follow the viewer's clock", () => {
	const tz = "Asia/Singapore";
	assert.equal(v2.zonedTime(2026, 10, 1, 8, 0, tz).toISOString(), "2026-10-01T00:00:00.000Z");
	assert.equal(v2.zonedTime(2026, 3, 8, 3, 30, "America/New_York").toISOString(), "2026-03-08T07:30:00.000Z");
	// Thursday 1 Oct 2026, 10:00 in Singapore.
	const now = new Date("2026-10-01T02:00:00Z");
	assert.equal(v2.resolveSnoozeTime("later", null, tz, now).toISOString(), "2026-10-01T10:00:00.000Z");
	assert.equal(v2.resolveSnoozeTime("tomorrow", null, tz, now).toISOString(), "2026-10-02T00:00:00.000Z");
	assert.equal(v2.resolveSnoozeTime("weekend", null, tz, now).toISOString(), "2026-10-03T00:00:00.000Z");
	assert.equal(v2.resolveSnoozeTime("nextweek", null, tz, now).toISOString(), "2026-10-05T00:00:00.000Z");
	assert.equal(v2.resolveSnoozeTime("custom", "2026-10-01T09:00", tz, now), null, "past times are refused");
	assert.equal(v2.resolveSnoozeTime("custom", "2026-12-25T09:15", tz, now).toISOString(), "2026-12-25T01:15:00.000Z");
	assert.equal(v2.resolveSnoozeTime("bogus", null, tz, now), null);
	// After 5 PM, "later" means three hours from now.
	const evening = new Date("2026-10-01T10:30:00Z");
	assert.equal(v2.resolveSnoozeTime("later", null, tz, evening).toISOString(), "2026-10-01T13:30:00.000Z");
});

test("list dates read like Gmail in the viewer's zone", () => {
	const now = new Date("2026-10-01T02:00:00Z");
	assert.equal(v2.formatListDate(new Date("2026-10-01T01:05:00Z"), "Asia/Singapore", now), "9:05 AM");
	assert.equal(v2.formatListDate(new Date("2026-08-24T03:09:00Z"), "Asia/Singapore", now), "Aug 24");
	assert.equal(v2.formatListDate(new Date("2025-12-19T08:55:00Z"), "Asia/Singapore", now), "12/19/25");
	assert.equal(v2.resolveTimeZone("Not/AZone"), "UTC");
	assert.equal(v2.initials("Alice Smith"), "AS");
	assert.equal(v2.initials("  "), "?");
	assert.equal(v2.recipientSummary(`"Bob B" <bob@x.com>, ME@y.com`, new Set(["me@y.com"])), "Bob B, me");
});

test("lists read the conversation summary except for searches and drafts", () => {
	assert.equal(v2.summaryView("inbox", null, ""), "inbox");
	assert.equal(v2.summaryView("snoozed", null, null), "inbox");
	assert.equal(v2.summaryView("folder", "fld_1", null), "folder:fld_1");
	assert.equal(v2.summaryView("folder", null, null), null);
	assert.equal(v2.summaryView("archive", null, null), "archive");
	assert.equal(v2.summaryView("inbox", null, "from:bob"), null);
	assert.equal(v2.summaryView("search", null, "x"), null);
	assert.equal(v2.summaryView("drafts", null, null), null);
});

test("view membership matches the conversation_views triggers", () => {
	const now = new Date("2026-10-01T00:00:00Z");
	const base = { direction: "inbound", status: "received", folderId: null, starred: false, snoozedUntil: null };
	const later = new Date("2026-10-02T00:00:00Z");
	assert.equal(v2.memberInView(base, "inbox", null, now), true);
	assert.equal(v2.memberInView({ ...base, snoozedUntil: later }, "inbox", null, now), false);
	assert.equal(v2.memberInView({ ...base, snoozedUntil: later }, "snoozed", null, now), true);
	assert.equal(v2.memberInView({ ...base, folderId: "f" }, "inbox", null, now), false);
	assert.equal(v2.memberInView({ ...base, folderId: "f" }, "folder", "f", now), true);
	assert.equal(v2.memberInView({ ...base, folderId: "f", status: "trash" }, "folder", "f", now), false);
	assert.equal(v2.memberInView({ ...base, direction: "outbound", status: "queued" }, "sent", null, now), true);
	assert.equal(v2.memberInView({ ...base, starred: true, status: "spam" }, "starred", null, now), false);
	assert.equal(v2.memberInView({ ...base, status: "archived" }, "all", null, now), true);
	assert.equal(v2.memberInView({ ...base, status: "draft" }, "all", null, now), false);
});
