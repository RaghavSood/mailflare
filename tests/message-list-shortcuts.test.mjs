import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where a moved message returns to, and which keys act on a selection. Both are
 * pure helpers, bundled with esbuild for the `@/*` alias.
 */
const outDir = mkdtempSync(join(tmpdir(), "mailflare-shortcuts-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { getMessageListHref, isMoveMessageAction } from "./src/components/message-actions/utils.ts";
			export { getBulkSelectionShortcuts } from "./src/components/messages/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "shortcuts-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { getMessageListHref, isMoveMessageAction, getBulkSelectionShortcuts } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

test("a moved message returns to the list it was opened from", () => {
	assert.equal(getMessageListHref("/inbox/msg_1", "msg_1"), "/inbox");
	assert.equal(getMessageListHref("/starred/msg_1/", "msg_1"), "/starred");
	assert.equal(getMessageListHref("/folders/fld_9/msg_1", "msg_1"), "/folders/fld_9");
	// Not this message's page (another thread message, or a list): stay put.
	assert.equal(getMessageListHref("/inbox/msg_2", "msg_1"), null);
	assert.equal(getMessageListHref("/inbox", "inbox"), null);
});

test("only actions that take a message out of its list navigate away", () => {
	for (const action of ["trash", "archive", "spam", "inbox", "folder"]) assert.ok(isMoveMessageAction(action), action);
	for (const action of ["read", "unread"]) assert.ok(!isMoveMessageAction(action), action);
});

test("selection keys map to the bulk actions", () => {
	const calls = [];
	let cleared = 0;
	const shortcuts = getBulkSelectionShortcuts({
		onAction: (action) => calls.push(action),
		onClearSelection: () => {
			cleared += 1;
		},
	});
	const press = (key, modifiers) => {
		const match = shortcuts.find((item) => item.key === key && (item.modifiers ?? []).join() === (modifiers ?? []).join());
		assert.ok(match, `no shortcut for ${key}`);
		match.action();
	};
	press("#");
	press("delete");
	press("backspace");
	press("e");
	press("y");
	press("!");
	press("i", ["shift"]);
	press("u", ["shift"]);
	press("escape");
	assert.deepEqual(calls, ["trash", "trash", "trash", "archive", "archive", "spam", "read", "unread"]);
	assert.equal(cleared, 1);
});
