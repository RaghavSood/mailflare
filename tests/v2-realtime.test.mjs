import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The realtime socket decides what to do from app.js's DOM-free realtimeStep, between the
 * pure:start and pure:end markers. The server sends push notifications only to a user with
 * no open socket, so a hidden page must not keep one open.
 */
const source = await readFile(join(root, "public/v2-assets/app.js"), "utf8");
const start = source.indexOf("/* pure:start");
const end = source.indexOf("/* pure:end */");
assert.ok(start > 0 && end > start, "app.js keeps its pure:start / pure:end markers");
const context = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}
	this.helpers = { realtimeStep, staleBackgroundAnswer };`, context);
const { realtimeStep, staleBackgroundAnswer } = context.helpers;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("a page that is hidden closes its socket, so the server pushes new mail instead", () => {
	assert.deepEqual(plain(realtimeStep("hidden", { visible: false, socket: true })), { close: true });
	assert.deepEqual(plain(realtimeStep("hidden", { visible: false, socket: false })), { close: false });
});

test("a page shown again reconnects and catches up on what it missed", () => {
	assert.deepEqual(plain(realtimeStep("visible", { visible: true, socket: false })), { connect: true, catchUp: true });
	// A socket still open (a hide too short to close it) is kept; the page still refreshes.
	assert.deepEqual(plain(realtimeStep("visible", { visible: true, socket: true })), { connect: false, catchUp: true });
});

test("a socket lost while shown retries with backoff; one lost while hidden waits for the page to be shown", () => {
	assert.deepEqual(plain(realtimeStep("lost", { visible: true, socket: false, attempt: 0 })), { retryIn: 1000 });
	assert.deepEqual(plain(realtimeStep("lost", { visible: true, socket: false, attempt: 3 })), { retryIn: 8000 });
	assert.deepEqual(plain(realtimeStep("lost", { visible: true, socket: false, attempt: 10 })), { retryIn: 30000 });
	assert.deepEqual(plain(realtimeStep("lost", { visible: false, socket: false, attempt: 0 })), {});
});

test("a reconnect timer that fires while the page is hidden, or after it reconnected, does nothing", () => {
	assert.equal(realtimeStep("retry", { visible: true, socket: false }).connect, true);
	assert.equal(realtimeStep("retry", { visible: false, socket: false }).connect, false);
	assert.equal(realtimeStep("retry", { visible: true, socket: true }).connect, false);
});

test("a background reload's answer is dropped once the page it was sent from is left", () => {
	const inbox = { href: "http://localhost/v2/inbox", navigations: 3, loading: 0 };
	assert.equal(staleBackgroundAnswer(inbox, { ...inbox }), false);
	// A notification opened a conversation after the reload was sent: the answer lands after it is shown.
	assert.equal(staleBackgroundAnswer(inbox, { href: "http://localhost/v2/inbox/msg_1", navigations: 4, loading: 0 }), true);
	// The conversation is still loading (the address has not changed yet).
	assert.equal(staleBackgroundAnswer(inbox, { href: inbox.href, navigations: 4, loading: 1 }), true);
	// New mail arrived while the conversation was loading: the reload was sent after the navigation started.
	assert.equal(staleBackgroundAnswer({ ...inbox, navigations: 4 }, { href: inbox.href, navigations: 4, loading: 1 }), true);
	// Left and back at the same address: still another page load since.
	assert.equal(staleBackgroundAnswer(inbox, { href: inbox.href, navigations: 5, loading: 0 }), true);
});
