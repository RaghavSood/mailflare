import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * app.js has no build step, so its DOM-free touch helpers sit between pure:start and
 * pure:end markers. Run that block on its own and check the rules swipes and
 * recipient chips depend on.
 */
const source = await readFile(join(root, "public/v2-assets/app.js"), "utf8");
const start = source.indexOf("/* pure:start");
const end = source.indexOf("/* pure:end */");
assert.ok(start > 0 && end > start, "app.js keeps its pure:start / pure:end markers");
const context = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}
	this.helpers = { swipeOutcome, splitRecipients, isCompleteAddress, parseRecipient };`, context);
const { swipeOutcome, splitRecipients, isCompleteAddress, parseRecipient } = context.helpers;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("a swipe commits past 35% of the row and only in a direction that has an action", () => {
	const both = { right: "archive", left: "trash" };
	assert.equal(swipeOutcome(140, 400, both), "archive");
	assert.equal(swipeOutcome(-140, 400, both), "trash");
	assert.equal(swipeOutcome(139, 400, both), null);
	assert.equal(swipeOutcome(-60, 400, both), null);
	// Trash has no trash action; Sent has no archive.
	assert.equal(swipeOutcome(-300, 400, { right: "inbox", left: null }), null);
	assert.equal(swipeOutcome(300, 400, { right: "inbox", left: null }), "inbox");
	assert.equal(swipeOutcome(300, 400, { right: null, left: "trash" }), null);
	assert.equal(swipeOutcome(300, 0, both), null);
});

test("recipients split on commas and semicolons, but not inside quotes or angle brackets", () => {
	assert.deepEqual(plain(splitRecipients("a@example.com, b@example.com, ma")), { done: ["a@example.com", "b@example.com"], rest: "ma" });
	assert.deepEqual(plain(splitRecipients("\"Chen, Maya\" <maya@acme.test>; bob@x.io;")), { done: ["\"Chen, Maya\" <maya@acme.test>", "bob@x.io"], rest: "" });
	assert.deepEqual(plain(splitRecipients("Maya <maya@acme")), { done: [], rest: "Maya <maya@acme" });
	assert.deepEqual(plain(splitRecipients(" , ,  c@d.io")), { done: [], rest: "c@d.io" });
});

test("only finished addresses become chips on blur", () => {
	for (const value of ["a@example.com", " a.b+c@sub.example.co ", "Maya Chen <maya@acme.test>", "\"Chen, Maya\" <maya@acme.test>"]) assert.ok(isCompleteAddress(value), value);
	for (const value of ["", "maya", "maya@", "maya@acme", "Maya Chen", "Maya <maya@acme.test", "a b@example.com"]) assert.ok(!isCompleteAddress(value), value);
});

test("a chip shows the display name and keeps the address", () => {
	assert.deepEqual(plain(parseRecipient("Maya Chen <maya@acme.test>")), { name: "Maya Chen", email: "maya@acme.test" });
	assert.deepEqual(plain(parseRecipient("\"Chen, Maya\" <maya@acme.test>")), { name: "Chen, Maya", email: "maya@acme.test" });
	assert.deepEqual(plain(parseRecipient(" bob@x.io ")), { name: "", email: "bob@x.io" });
});
