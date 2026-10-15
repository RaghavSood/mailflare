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
			export { historyHeaders } from "./src/lib/v2/handler-utils.ts";
			export { neutralizeEmailHtml, buildMailFrameDocument, plainTextToHtml, resolveContentIds } from "./src/lib/v2/render/mail-frame.ts";
			export { buildParticipants, chunk, summaryView, memberInView } from "./src/lib/v2/data/list-utils.ts";
			export { pickActionTargets, parseUndoEntries } from "./src/lib/v2/data/thread-utils.ts";
			export { buildReplyRecipients, replySubject, buildQuoteHtml, htmlToMailText, parseFromValue, draftForSend, DraftGoneError, DraftSendingError } from "./src/lib/v2/data/compose-utils.ts";
			export { zonedTime, resolveSnoozeTime } from "./src/lib/v2/data/time-utils.ts";
			export { formatListDate, initials, recipientSummary, resolveTimeZone } from "./src/lib/v2/render/format.ts";
			export { homePathFor } from "./src/lib/v2/preference.ts";
			export { renderPage, ASSET_VERSION, HTMX_VERSION, SERVICE_WORKER_URL } from "./src/lib/v2/render/layout.ts";
			export { renderComposer } from "./src/lib/v2/render/compose.ts";
			export { renderDetails, renderThreadMain } from "./src/lib/v2/render/thread.ts";
			export { renderListMain } from "./src/lib/v2/render/list.ts";
			export { resolvePushControlState, shownPushControlState, pushKeyFailureState, describePushError, PUSH_OFFLINE_MESSAGE } from "./src/components/settings/push-notifications-utils.ts";
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

test("a send moves the address off a composer page that no longer exists, and only then", () => {
	// Sent from a draft opened from Drafts: the draft is gone, so the Drafts list takes its history entry.
	assert.deepEqual(v2.historyHeaders("replace", "/v2/drafts", "/v2/drafts/msg_1"), { "HX-Replace-Url": "/v2/drafts" });
	// /v2/compose (new, or ?draft=) answers with the Inbox.
	assert.deepEqual(v2.historyHeaders("replace", "/v2/inbox", "/v2/compose?draft=msg_1"), { "HX-Replace-Url": "/v2/inbox" });
	assert.deepEqual(v2.historyHeaders("replace", "/v2/inbox", "/v2/compose"), { "HX-Replace-Url": "/v2/inbox" });
	// The docked composer and an inline reply return to the page they were on: nothing to change.
	assert.deepEqual(v2.historyHeaders("replace", "/v2/inbox?page=2", "/v2/inbox?page=2"), { "HX-Push-Url": "false" });
	assert.deepEqual(v2.historyHeaders("replace", "/v2/inbox/msg_2", "/v2/inbox/msg_2"), { "HX-Push-Url": "false" });
	// Without HX-Current-URL the page shown still names itself.
	assert.deepEqual(v2.historyHeaders("replace", "/v2/drafts", null), { "HX-Replace-Url": "/v2/drafts" });
	// Other actions keep their behaviour: push when the view changes, otherwise leave the address alone.
	assert.deepEqual(v2.historyHeaders("push", "/v2/inbox", "/v2/inbox/msg_2"), { "HX-Push-Url": "/v2/inbox" });
	assert.deepEqual(v2.historyHeaders("none", "/v2/inbox", "/v2/inbox/msg_2"), { "HX-Push-Url": "false" });
});

test("email HTML loses active tags before it reaches the sandboxed frame", () => {
	const dirty = `<META http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/"><script>alert(1)</script><iframe src=x></iframe><form action=x><p>Hi</p></form><scripted>ok</scripted>`;
	const clean = v2.neutralizeEmailHtml(dirty);
	assert.doesNotMatch(clean, /<(meta|base|script|iframe|form)[\s>]/i);
	assert.doesNotMatch(clean, /refresh|evil\/"/);
	assert.match(clean, /<x-blocked-script>alert\(1\)<\/x-blocked-script>/);
	assert.match(clean, /<x-blocked-form action=x><p>Hi<\/p><\/x-blocked-form>/);
	assert.match(clean, /<scripted>ok<\/scripted>/);
	// Void tags are removed, not renamed: a renamed one would wrap (and hide) the rest of the email.
	assert.equal(
		v2.neutralizeEmailHtml(`<head><meta name="viewport" content="a>b" /><link rel="stylesheet" href="https://x/s.css"></head><body><p>Shown</p></body>`),
		`<head><link rel="stylesheet" href="https://x/s.css"></head><body><p>Shown</p></body>`,
	);
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

test("v2 pages link the web app manifest and hand app.js the versioned service worker", async () => {
	const { readFile } = await import("node:fs/promises");
	const url = new URL("https://mail.example.com/v2/inbox");
	const ctx = {
		env: {},
		request: new Request(url),
		user: { id: "usr_1", email: "me@example.com", name: "Me" },
		url,
		mailboxes: [{ id: "mbx_1", address: "me@example.com" }],
		scopeMailboxIds: ["mbx_1"],
		selectedMailboxId: null,
		theme: "system",
		shortcutsEnabled: true,
		htmx: false,
	};
	const nav = { counts: { inbox: 0, spam: 0, drafts: 0, folders: new Map() }, folders: [], active: { view: "inbox", folderId: null } };
	const out = String(v2.renderPage(ctx, { title: "Inbox", main: v2.html`<main id="main"></main>`, nav }));

	assert.match(out, /<link rel="manifest" href="\/manifest\.webmanifest">/);
	assert.match(out, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
	assert.match(out, /<meta name="apple-mobile-web-app-capable" content="yes">/);
	assert.match(out, /<meta name="apple-mobile-web-app-status-bar-style" content="[a-z-]+">/);
	assert.equal(v2.SERVICE_WORKER_URL, `/sw.js?v=${v2.ASSET_VERSION}&htmx=${v2.HTMX_VERSION}`);
	assert.ok(out.includes(`data-sw="/sw.js?v=${v2.ASSET_VERSION}&amp;htmx=${v2.HTMX_VERSION}"`), "body carries the worker URL");
	assert.ok(out.includes(`/v2-assets/app.js?v=${v2.ASSET_VERSION}`));
	assert.ok(out.includes(`/v2-assets/htmx.min.js?v=${v2.HTMX_VERSION}`));
	// Offline support: the user its caches and outbox are keyed by, the shared module before app.js, and the banner.
	assert.match(out, /<body [^>]*data-user="usr_1"/);
	assert.ok(out.indexOf(`/v2-assets/offline.js?v=${v2.ASSET_VERSION}`) > 0 && out.indexOf(`/v2-assets/offline.js?v=${v2.ASSET_VERSION}`) < out.indexOf("/v2-assets/app.js"));
	assert.match(out, /<div class="offline-banner" data-offline-banner role="status" aria-live="polite" hidden>/);

	// app.js registers whatever the body names, scoped to the v2 interface.
	const app = await readFile(join(root, "public/v2-assets/app.js"), "utf8");
	assert.match(app, /navigator\.serviceWorker\.register\(url, \{ scope: "\/v2\/" \}\)/);
	assert.match(app, /body\.dataset\.sw/);

	// The manifest launches into v2 and ships the install icon sizes.
	const manifest = JSON.parse(await readFile(join(root, "public/manifest.webmanifest"), "utf8"));
	assert.equal(manifest.start_url, "/v2/inbox");
	assert.equal(manifest.scope, "/v2/");
	assert.equal(manifest.display, "standalone");
	const sizes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
	assert.deepEqual(sizes.sort(), ["192x192:any", "512x512:any", "512x512:maskable"]);
	for (const icon of manifest.icons) await readFile(join(root, "public", icon.src));
});

test("with a VAPID key the body carries it and the sidebar has the notifications toggle; without one, neither", () => {
	const url = new URL("https://mail.example.com/v2/inbox");
	const base = {
		env: {},
		request: new Request(url),
		user: { id: "usr_1", email: "me@example.com", name: "Me" },
		url,
		mailboxes: [{ id: "mbx_1", address: "me@example.com" }],
		scopeMailboxIds: ["mbx_1"],
		selectedMailboxId: null,
		theme: "system",
		shortcutsEnabled: true,
		htmx: false,
	};
	const nav = { counts: { inbox: 0, spam: 0, drafts: 0, folders: new Map() }, folders: [], active: { view: "inbox", folderId: null } };
	const key = "BIuNlFWwIuxLrm4ojdfE77tWjtlPL1m1ZSPim_3nmBbkip0zmTH6-h4xblviIyt9prcYBwhAEB5O_CgqMfLs-HM";
	const on = String(v2.renderPage({ ...base, vapidPublicKey: key }, { title: "Inbox", main: v2.html`<main id="main"></main>`, nav }));
	assert.ok(on.includes(` data-vapid-key="${key}"`), "body carries the public key");
	const toggle = /<button type="button" class="nav-item subtle push-toggle" data-push hidden>[\s\S]*?<\/button>/.exec(on)?.[0];
	assert.ok(toggle, "sidebar footer renders the toggle, hidden until app.js reads the browser's state");
	assert.match(toggle, /data-push-label>Notifications</);
	assert.ok(on.indexOf("data-push") < on.indexOf('href="/settings/account"'), "toggle sits in the sidebar footer above Settings");

	const off = String(v2.renderPage({ ...base, vapidPublicKey: null }, { title: "Inbox", main: v2.html`<main id="main"></main>`, nav }));
	assert.ok(!off.includes("data-vapid-key"));
	assert.ok(!off.includes("data-push"));
});

test("the opt-in state: install first on iOS outside the app, blocked, off, on, and off again after a key change or a sign-out", () => {
	const key = "BKEY";
	const env = { publicKey: key, supported: true, ios: false, standalone: false, permission: "granted", subscribedKey: key, subscribed: true, registered: true };
	assert.equal(v2.resolvePushControlState(env), "on");
	assert.equal(v2.resolvePushControlState({ ...env, publicKey: null }), "unavailable");
	assert.equal(v2.resolvePushControlState({ ...env, ios: true }), "install");
	assert.equal(v2.resolvePushControlState({ ...env, ios: true, standalone: true }), "on");
	assert.equal(v2.resolvePushControlState({ ...env, supported: false }), "unsupported");
	assert.equal(v2.resolvePushControlState({ ...env, permission: "denied" }), "blocked");
	assert.equal(v2.resolvePushControlState({ ...env, permission: "default" }), "off");
	assert.equal(v2.resolvePushControlState({ ...env, subscribed: false, subscribedKey: null }), "off");
	assert.equal(v2.resolvePushControlState({ ...env, subscribedKey: "OLDKEY" }), "off");
	// After a sign-out the server has no row: the browser's leftover subscription is not "on".
	assert.equal(v2.resolvePushControlState({ ...env, registered: false }), "off");
	// The check could not be made (offline): trust the browser.
	assert.equal(v2.resolvePushControlState({ ...env, registered: null }), "on");
});

test("offline, the classic push card says so instead of claiming push is not configured", () => {
	// The key could not be loaded: offline (or a dropped connection) is not "unavailable".
	assert.equal(v2.pushKeyFailureState(new TypeError("Failed to fetch"), true), "offline");
	assert.equal(v2.pushKeyFailureState(new Error("Could not check notifications"), false), "offline");
	assert.equal(v2.pushKeyFailureState(new Error("Could not check notifications"), true), "unavailable");
	// Opened offline it does not sit on "Checking...".
	assert.equal(v2.shownPushControlState("loading", false), "offline");
	assert.equal(v2.shownPushControlState("loading", true), "loading");
	assert.equal(v2.shownPushControlState("offline", true), "offline", "a failing connection the browser calls online");
	assert.equal(v2.shownPushControlState("on", false), "on", "the known state stays visible offline");
	assert.equal(v2.shownPushControlState("off", true), "off");
	// Failures read as offline, never as the raw "Failed to fetch".
	assert.equal(v2.describePushError(new TypeError("Failed to fetch"), true, "x"), v2.PUSH_OFFLINE_MESSAGE);
	assert.equal(v2.describePushError(new Error("anything"), false, "x"), v2.PUSH_OFFLINE_MESSAGE);
	assert.match(v2.describePushError(new DOMException("Registration failed - push service error", "AbortError"), true, "x"), /push service/);
	assert.equal(v2.describePushError(new Error("This key is out of date."), true, "x"), "This key is out of date.");
	assert.equal(v2.describePushError("nope", true, "Could not turn on notifications"), "Could not turn on notifications");
	assert.match(v2.PUSH_OFFLINE_MESSAGE, /^You're offline/);
});

/** Runs public/sw.js against a fake ServiceWorkerGlobalScope and returns its listeners and spies. */
async function loadServiceWorker({ windows = [] } = {}) {
	const { readFile } = await import("node:fs/promises");
	const { createContext, runInContext } = await import("node:vm");
	const source = await readFile(join(root, "public/sw.js"), "utf8");
	const offline = await readFile(join(root, "public/v2-assets/offline.js"), "utf8");
	const listeners = {};
	const shown = [];
	const opened = [];
	const self = {
		location: new URL("https://mail.example.com/sw.js?v=3&htmx=2.0.11"),
		addEventListener: (type, listener) => { listeners[type] = listener; },
		registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
		clients: {
			matchAll: async () => windows,
			openWindow: async (url) => { opened.push(url); },
			claim: async () => {},
		},
	};
	const context = createContext({ self, URL, Uint8Array, atob, JSON, console, caches: {}, fetch: async () => { throw new Error("offline"); } });
	// The worker loads the shared offline module first.
	context.importScripts = () => runInContext(offline, context);
	runInContext(source, context);
	async function dispatch(type, event) {
		let pending;
		listeners[type]({ ...event, waitUntil: (promise) => { pending = promise; } });
		await pending;
	}
	return { listeners, shown, opened, dispatch };
}

test("service worker shows a notification for every push, titled by sender and tagged by message", async () => {
	const sw = await loadServiceWorker();
	await sw.dispatch("push", { data: { json: () => ({ messageId: "msg_42", from: "alice@example.org", fromName: "Alice", subject: "Lunch?" }) } });
	await sw.dispatch("push", { data: { json: () => ({ messageId: "msg_43", from: "bob@example.org", fromName: null, subject: null }) } });
	// A push that cannot be read still shows something, as userVisibleOnly requires.
	await sw.dispatch("push", { data: { json: () => { throw new SyntaxError("bad"); } } });
	assert.deepEqual(JSON.parse(JSON.stringify(sw.shown)), [
		{ title: "Alice", options: { body: "Lunch?", tag: "msg_42", icon: "/icon-192.png", data: { url: "/v2/inbox/msg_42" } } },
		{ title: "bob@example.org", options: { body: "(no subject)", tag: "msg_43", icon: "/icon-192.png", data: { url: "/v2/inbox/msg_43" } } },
		{ title: "New mail", options: { body: "(no subject)", icon: "/icon-192.png", data: { url: "/v2/inbox" } } },
	]);
	assert.ok(sw.listeners.pushsubscriptionchange, "re-subscribes when the push service rotates the subscription");
});

test("notification click focuses an open v2 window and opens the message there, or opens a new window", async () => {
	const messages = [];
	const v2Window = {
		url: "https://mail.example.com/v2/inbox",
		focus: async () => v2Window,
		postMessage: (message) => messages.push(message),
		navigate: async () => {},
	};
	const classicWindow = { url: "https://mail.example.com/settings/account", focus: async () => classicWindow, postMessage: () => assert.fail("classic window") };
	let closed = 0;
	const notification = { data: { url: "/v2/inbox/msg_42" }, close: () => { closed += 1; } };

	const open = await loadServiceWorker({ windows: [classicWindow, v2Window] });
	await open.dispatch("notificationclick", { notification });
	assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "mf:open", url: "https://mail.example.com/v2/inbox/msg_42" }]);
	assert.equal(open.opened.length, 0);

	const none = await loadServiceWorker({ windows: [classicWindow] });
	await none.dispatch("notificationclick", { notification });
	assert.deepEqual([...none.opened], ["https://mail.example.com/v2/inbox/msg_42"]);
	assert.equal(closed, 2);
});

test("a send goes ahead only with the claim on its draft", () => {
	assert.equal(v2.draftForSend(null, null), null, "a fresh message has no draft");
	const draft = { id: "msg_1" };
	assert.equal(v2.draftForSend("msg_1", { outcome: "claimed", draft }), draft);
	assert.throws(() => v2.draftForSend("msg_1", { outcome: "gone" }), v2.DraftGoneError);
	assert.throws(() => v2.draftForSend("msg_1", null), /already sent or its draft was discarded/);
	// Another request holds the claim: refused, not sent a second time.
	assert.throws(() => v2.draftForSend("msg_1", { outcome: "sending" }), v2.DraftSendingError);
	assert.throws(() => v2.draftForSend("msg_1", { outcome: "sending" }), /already being sent/);
});

test("v2 pages tell htmx to settle a swap at once (#31)", () => {
	const url = new URL("https://mail.example.com/v2/inbox");
	const ctx = { env: {}, request: new Request(url), user: { id: "usr_1", email: "me@example.com", name: "Me" }, url, mailboxes: [{ id: "mbx_1", address: "me@example.com" }], scopeMailboxIds: ["mbx_1"], selectedMailboxId: null, theme: "system", shortcutsEnabled: true, htmx: false };
	const nav = { counts: { inbox: 0, spam: 0, drafts: 0, folders: new Map() }, folders: [], active: { view: "inbox", folderId: null } };
	const out = String(v2.renderPage(ctx, { title: "Inbox", main: v2.html`<main id="main"></main>`, nav }));
	const content = /<meta name="htmx-config" content="([^"]*)">/.exec(out)?.[1];
	assert.ok(content, "the page carries an htmx-config meta");
	const config = JSON.parse(content.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
	// htmx wires a swapped-in page's hx- attributes, and app.js runs onPage (which closes menus) and
	// the tablet split list, only when the swap settles. Any settle delay is a window in which a click
	// on the new page does nothing: the details toggle has no listener yet, and a menu opened in it is
	// shut again.
	assert.equal(config.defaultSettleDelay, 0);
});

test("touch markup: the keyboard resizes the page, the rail names its items, recipients get an email keyboard, details can close", () => {
	const url = new URL("https://mail.example.com/v2/inbox");
	const ctx = {
		env: {},
		request: new Request(url),
		user: { id: "usr_1", email: "me@example.com", name: "Me" },
		url,
		mailboxes: [{ id: "mbx_1", address: "me@example.com" }],
		scopeMailboxIds: ["mbx_1"],
		selectedMailboxId: null,
		theme: "system",
		shortcutsEnabled: true,
		htmx: false,
	};
	const nav = { counts: { inbox: 2, spam: 0, drafts: 0, folders: new Map() }, folders: [{ id: "fld_1", name: "Receipts", color: null, unread: 0 }], active: { view: "inbox", folderId: null } };
	const page = String(v2.renderPage(ctx, { title: "Inbox", main: v2.html`<main id="main"></main>`, nav }));
	assert.match(page, /<meta name="viewport" content="[^"]*interactive-widget=resizes-content[^"]*">/);
	// The tablet rail hides labels, so every item carries its name as a title.
	assert.match(page, /href="\/v2\/inbox" title="Inbox"/);
	assert.match(page, /title="Receipts"/);
	for (const label of ["Settings", "Keyboard shortcuts", "Switch to classic"]) assert.ok(page.includes(`title="${label}"`), label);

	const composer = String(v2.renderComposer(
		{ id: null, mailboxId: "mbx_1", from: "me@example.com", to: "a@example.com", cc: "", bcc: "", subject: "", bodyHtml: "", quoteHtml: "", inReplyTo: null, references: null, threadId: null, attachments: [] },
		{ mailboxes: [{ id: "mbx_1", address: "me@example.com", name: "Me", canSend: true, senderAddresses: [], catchAllHostnames: [] }], mode: "page", key: "t", returnHref: "/v2/inbox" },
	));
	const recipients = composer.match(/<input[^>]*data-recipients[^>]*>/g) ?? [];
	assert.equal(recipients.length, 3);
	for (const input of recipients) {
		assert.match(input, /inputmode="email"/);
		assert.match(input, /autocapitalize="off"/);
		assert.match(input, /enterkeyhint="next"/);
	}
	// The composer key is left for app.js to make up per composer: a cached page must not share one.
	assert.match(composer, /<input type="hidden" name="composeKey" value="" data-compose-key>/);

	const details = String(v2.renderDetails(
		{ id: "msg_1", direction: "inbound", fromAddr: "a@example.com", toAddr: "me@example.com", ccAddr: null, bccAddr: null, subject: "Hi", deliveredTo: null, createdAt: new Date("2026-10-14T08:00:00Z") },
		null,
		false,
		"UTC",
	));
	// The close button reuses the details toggle, so it needs no script of its own.
	assert.match(details, /<button type="button" class="icon-button sheet-close" data-details="msg_1" aria-label="Close details">/);
});

test("toolbar buttons outside their form submit it with their own name and value", () => {
	const url = new URL("https://mail.example.com/v2/inbox/msg_1");
	const ctx = { user: { id: "usr_1", email: "me@example.com", name: "Me" }, url, mailboxes: [], scopeMailboxIds: ["mbx_1"] };
	const folders = [{ id: "fld_1", name: "Receipts", color: null, unread: 0 }];
	const message = {
		id: "msg_1", mailboxId: "mbx_1", direction: "inbound", status: "received", folderId: null, fromAddr: "a@example.com", fromName: "A", toAddr: "me@example.com",
		ccAddr: null, bccAddr: null, deliveredTo: null, subject: "Hi", snippet: "Hi", textBody: "Hi", htmlBody: null, createdAt: new Date("2026-10-14T08:00:00Z"),
		read: true, starred: false, providerMessageId: null, references: null, threadId: null, attachments: [],
	};
	const pages = [];
	for (const view of ["inbox", "archive", "spam", "trash", "starred", "folder", "drafts"]) {
		pages.push([`thread ${view}`, String(v2.renderThreadMain(ctx, {
			view, folderId: view === "folder" ? "fld_1" : null, q: "", thread: { key: "msg_1", subject: "Hi", messages: [message], mailboxId: "mbx_1" },
			listHref: `/v2/${view}`, index: 0, total: 1, newerHref: null, olderHref: null, folders, timeZone: "UTC", ownAddresses: new Set(["me@example.com"]), expandedIds: new Set(),
		}))]);
	}
	for (const view of ["inbox", "archive", "spam", "trash", "sent", "drafts", "all"]) {
		pages.push([`list ${view}`, String(v2.renderListMain(ctx, {
			view, title: view, folderId: null, q: "", page: { rows: [], total: 0, page: 1, pageSize: 50 }, folders, timeZone: "UTC", emptyText: "Nothing here.",
		}))]);
	}
	for (const [name, markup] of pages) {
		const buttons = markup.match(/<button\b[^>]*\sform="[^"]*"[^>]*>/g) ?? [];
		assert.ok(buttons.length > 0, name);
		// htmx records the clicked button of a boosted form only for type="submit" buttons that name the form.
		for (const button of buttons) assert.match(button, /\stype="submit"/, `${name}: ${button}`);
		// Enter in the snooze date field clicks the form's first submit button: that must be the custom snooze.
		for (const formId of new Set(buttons.map((button) => button.match(/\sform="([^"]*)"/)[1]))) {
			const own = buttons.filter((button) => button.includes(`form="${formId}"`));
			if (!markup.includes(`name="snoozeAt" form="${formId}"`)) {
				assert.ok(!own.some((button) => button.includes(" hidden")), `${name}: no hidden default without a date field`);
				continue;
			}
			assert.match(own[0], /name="snooze" value="custom" hidden/, `${name}: ${own[0]}`);
		}
	}
	// The toolbar focus shortcut lands on the first link or button, so the hidden one never comes first.
	for (const [name, markup] of pages) {
		const toolbar = markup.slice(markup.indexOf('class="toolbar"'));
		const first = toolbar.match(/<(a|button|summary)\b[^>]*>/)[0];
		assert.ok(!first.includes(" hidden"), `${name}: ${first}`);
	}
});

test("on a phone every list action fits: the pager hides while selecting and the rest go into More (#47)", async () => {
	const { readFile } = await import("node:fs/promises");
	const css = await readFile(join(root, "public/v2-assets/app.css"), "utf8");
	const appJs = await readFile(join(root, "public/v2-assets/app.js"), "utf8");
	const phone = css.slice(css.indexOf("/* ---------- touch: sheets, gestures, recipients ---------- */"));
	const phoneBlock = phone.slice(phone.indexOf("@media (max-width: 899px) {"), phone.indexOf("@media (max-width: 1199px)"));
	// What the markup below relies on, all of it inside the <900px rules so desktop and tablet keep their toolbar.
	assert.match(phoneBlock, /\[data-page="list"\]\.has-selection \.tb-pager \{ display: none; \}/);
	assert.match(phoneBlock, /\.tb-selected \.tb-overflow \{ display: none; \}/);
	assert.match(phoneBlock, /\.tb-more \{ display: block; \}/);
	assert.match(phoneBlock, /body:has\(#main details\.menu\[open\]\) \.fab \{ display: none; \}/, "the compose button stays off an open sheet");
	assert.match(css, /\.has-selection \.tb-idle \{ display: none; \}\n(\/\*.*\*\/\n)?\.tb-more \{ display: none; \}/, "More is hidden outside phones, next to the other selection rules");
	assert.match(phone, /@media \(max-width: 389px\) \{\s*\.tb-count-label \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect\(0 0 0 0\);/, "the word is clipped, not removed");
	assert.match(appJs, /className: "tb-count-label", textContent: " selected"/, "app.js writes the count as number + label");

	const ctx = { user: { id: "usr_1", email: "me@example.com", name: "Me" }, url: new URL("https://mail.example.com/v2/inbox"), mailboxes: [], scopeMailboxIds: ["mbx_1"] };
	const folders = [{ id: "fld_1", name: "Receipts", color: null, unread: 0 }];
	for (const view of ["inbox", "archive", "spam", "trash", "starred", "snoozed", "folder", "search", "all", "sent", "drafts"]) {
		const markup = String(v2.renderListMain(ctx, {
			view, title: view, folderId: view === "folder" ? "fld_1" : null, q: view === "search" ? "x" : "", page: { rows: [], total: 0, page: 1, pageSize: 50 }, folders, timeZone: "UTC", emptyText: "Nothing here.",
		}));
		assert.match(markup, /<div class="page" data-page="list"/, view);
		const toolbar = markup.slice(markup.indexOf('<div class="toolbar"'), markup.indexOf('<form id="list-form"'));
		assert.match(toolbar, /<div class="tb-pager">/, `${view}: the pager sits in the toolbar`);
		const selected = toolbar.slice(toolbar.indexOf('<div class="tb-group tb-selected">'), toolbar.indexOf('<div class="tb-spacer">'));
		const more = selected.match(/<details class="menu tb-more" data-menu="more">[\s\S]*?<\/details>/)?.[0];
		assert.ok(more, `${view}: no More menu`);
		const inline = selected.replace(/<details[\s\S]*?<\/details>/g, "");
		const values = (markup, pattern) => [...markup.matchAll(pattern)].map((match) => match[1]);
		const overflow = values(inline, /<button class="icon-button tb-overflow"[^>]*\svalue="([^"]+)"/g);
		const shown = values(inline, /<button class="icon-button"[^>]*\svalue="([^"]+)"/g);
		assert.deepEqual(values(more, /<button class="menu-item"[^>]*name="action" value="([^"]+)"/g), overflow, `${view}: More holds exactly the hidden actions`);
		assert.ok(["read", "unread"].every((value) => overflow.includes(value)), `${view}: ${overflow}`);
		assert.equal(overflow.includes("spam"), view !== "spam" && view !== "drafts", `${view}: spam`);
		const menus = values(selected, /<details class="[^"]*" data-menu="([^"]+)"/g);
		const canMove = view !== "sent" && view !== "drafts";
		assert.deepEqual(menus, canMove ? ["snooze", "move", "more"] : ["more"], view);
		// Select all, the count and at most five 44px controls fit 360px.
		assert.ok(shown.length + menus.length <= 5, `${view}: ${shown} + ${menus}`);
		assert.equal((markup.match(/data-menu="snooze"/g) ?? []).length, canMove ? 1 : 0, `${view}: one snooze menu`);
		assert.equal((markup.match(/name="snoozeAt"/g) ?? []).length, canMove ? 1 : 0, `${view}: one snooze date field`);
	}
});
