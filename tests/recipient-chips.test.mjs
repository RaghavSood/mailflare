import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Typed recipients turn into chips in two composers: the classic one (splitTypedRecipients in
 * src/components/compose/recipient-utils.ts) and v2 (splitRecipients with spaces in app.js's
 * pure block). Both must cut the same text at the same places, so one table checks both.
 */
const source = readFileSync(join(root, "public/v2-assets/app.js"), "utf8");
const start = source.indexOf("/* pure:start");
const end = source.indexOf("/* pure:end */");
assert.ok(start > 0 && end > start, "app.js keeps its pure:start / pure:end markers");
const context = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}
	this.helpers = { splitRecipients, isValidRecipient };`, context);
const { splitRecipients, isValidRecipient } = context.helpers;
const v2 = (text) => JSON.parse(JSON.stringify(splitRecipients(text, { spaces: true })));

const cacheDir = join(root, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "mailflare-recipient-chips-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/compose/recipient-utils.ts")],
	outfile: join(outDir, "recipient-utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { splitTypedRecipients, isValidRecipient: classicValid } = await import(pathToFileURL(join(outDir, "recipient-utils.mjs")).href);

const cases = [
	// [typed, done, rest]
	["bob@x.io", [], "bob@x.io"],
	["bob@x.io ", ["bob@x.io"], ""],
	["bob@x.io,", ["bob@x.io"], ""],
	["bob@x.io;", ["bob@x.io"], ""],
	["a@x.io b@y.io c", ["a@x.io", "b@y.io"], "c"],
	["a@x.io  b@y.io\t", ["a@x.io", "b@y.io"], ""],
	// A name keeps typing until its address is closed.
	["Maya ", [], "Maya "],
	["Maya Chen <maya@acme", [], "Maya Chen <maya@acme"],
	["Maya Chen <maya@acme.test> ", ["Maya Chen <maya@acme.test>"], ""],
	["\"Chen, Maya\" <maya@acme.test> bob@x.io ", ["\"Chen, Maya\" <maya@acme.test>", "bob@x.io"], ""],
	// Not yet an address: a space does not finish it.
	["maya@acme ", [], "maya@acme "],
	["maya ", [], "maya "],
	[" , ;  c@d.io", [], "c@d.io"],
];

test("a comma, semicolon, or space after a complete address finishes a chip, in both composers", () => {
	for (const [typed, done, rest] of cases) {
		assert.deepEqual(v2(typed), { done, rest }, `app.js: ${JSON.stringify(typed)}`);
		assert.deepEqual(splitTypedRecipients(typed), { done, rest }, `classic: ${JSON.stringify(typed)}`);
	}
});

test("without spaces, v2's split still only cuts at commas and semicolons (the Send check uses it)", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(splitRecipients("a@x.io b@y.io,"))), { done: ["a@x.io b@y.io"], rest: "" });
});

test("a chip is marked invalid when it holds no address", () => {
	for (const entry of ["maya@acme.test", "Maya Chen <maya@acme.test>", "\"Chen, Maya\" <maya@acme.test>"]) {
		assert.ok(isValidRecipient(entry), `app.js: ${entry}`);
		assert.ok(classicValid(entry), `classic: ${entry}`);
	}
	for (const entry of ["maya", "@", "maya@", "Maya Chen"]) {
		assert.ok(!isValidRecipient(entry), `app.js: ${entry}`);
		assert.ok(!classicValid(entry), `classic: ${entry}`);
	}
});
