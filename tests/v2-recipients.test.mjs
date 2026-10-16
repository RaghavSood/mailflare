import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Send refuses recipient fields twice: app.js before the request (recipientProblem in its pure
 * block) and /v2/send on the server (recipientProblem in compose-utils.ts). Both copies must agree,
 * so one table checks both. In #53 a touch meant for Send pressed the keyboard's "@" key instead,
 * and the message went out to "@".
 */
const source = readFileSync(join(root, "public/v2-assets/app.js"), "utf8");
const start = source.indexOf("/* pure:start");
const end = source.indexOf("/* pure:end */");
assert.ok(start > 0 && end > start, "app.js keeps its pure:start / pure:end markers");
const context = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}
	this.recipientProblem = recipientProblem;`, context);
const client = (to, cc = "", bcc = "") => context.recipientProblem([["to", to], ["cc", cc], ["bcc", bcc]])?.message ?? null;

const cacheDir = join(root, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "mailflare-recipients-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/v2/data/compose-utils.ts")],
	outfile: join(outDir, "compose-utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { recipientProblem } = await import(pathToFileURL(join(outDir, "compose-utils.mjs")).href);
const server = (to, cc = "", bcc = "") => recipientProblem({ to, cc, bcc });

const NONE = "Add at least one recipient.";
const cases = [
	// [to, cc, bcc, expected]
	["", "", "", NONE],
	["  ", "", "", NONE],
	[" , ;", "", "", NONE],
	["@", "", "", "\"@\" isn't an email address."],
	["maya", "", "", "\"maya\" isn't an email address."],
	["maya@", "", "", "\"maya@\" isn't an email address."],
	["@acme.test", "", "", "\"@acme.test\" isn't an email address."],
	["maya@acme.test, @", "", "", "\"@\" isn't an email address."],
	["maya@acme.test", "bob", "", "\"bob\" isn't an email address."],
	["maya@acme.test", "", "x y@acme.test", "\"x y@acme.test\" isn't an email address."],
	["", "maya@acme.test", "", NONE],
	["maya@acme.test", "", "", null],
	["support@localhost", "", "", null],
	["Maya Chen <maya@acme.test>", "", "", null],
	["\"Chen, Maya\" <maya@acme.test>; bob@x.io", "", "", null],
	["<maya@acme.test>", "", "", null],
	["maya@acme.test,", "bob@x.io", "carol@y.io", null],
];

test("Send needs a To entry, and every recipient must be an address", () => {
	for (const [to, cc, bcc, expected] of cases) {
		assert.equal(client(to, cc, bcc), expected, `app.js: to=${JSON.stringify(to)} cc=${JSON.stringify(cc)} bcc=${JSON.stringify(bcc)}`);
		assert.equal(server(to, cc, bcc), expected, `server: to=${JSON.stringify(to)} cc=${JSON.stringify(cc)} bcc=${JSON.stringify(bcc)}`);
	}
});

test("app.js points at the field to fix", () => {
	assert.equal(context.recipientProblem([["to", ""], ["cc", ""], ["bcc", ""]]).field, "to");
	assert.equal(context.recipientProblem([["to", "a@b.c"], ["cc", "@"], ["bcc", ""]]).field, "cc");
	assert.equal(context.recipientProblem([["to", "a@b.c"], ["cc", undefined], ["bcc", "x"]]).field, "bcc");
});
