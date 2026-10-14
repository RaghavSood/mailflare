import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Below `md` the settings sidebar becomes a single tab strip built from the same
 * sections, so the strip must list every link once, in order, and mark the active one.
 */
const outDir = mkdtempSync(join(tmpdir(), "mailflare-settings-nav-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export { flattenSettingsNavItems, isActiveSettingsPath, settingsNavSections } from "./src/components/settings/settings-nav-utils.ts";`,
		resolveDir: root,
		sourcefile: "settings-nav-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { flattenSettingsNavItems, isActiveSettingsPath, settingsNavSections } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

test("the tab strip lists every settings link once, in section order", () => {
	const items = flattenSettingsNavItems(settingsNavSections);
	assert.deepEqual(
		items.map((item) => item.href),
		settingsNavSections.flatMap((section) => section.items.map((item) => item.href)),
	);
	assert.equal(new Set(items.map((item) => item.href)).size, items.length);
	assert.deepEqual(items.slice(0, 2).map((item) => item.label), ["Account", "Inbox"]);
});

test("flattening keeps items from every section", () => {
	const items = flattenSettingsNavItems([
		{ label: "A", items: [{ href: "/a", label: "A" }] },
		{ label: "Empty", items: [] },
		{ label: "B", items: [{ href: "/b", label: "B" }, { href: "/c", label: "C" }] },
	]);
	assert.deepEqual(items.map((item) => item.href), ["/a", "/b", "/c"]);
});

test("a settings link is active on its page and on pages under it", () => {
	assert.ok(isActiveSettingsPath("/settings/rules", "/settings/rules"));
	assert.ok(isActiveSettingsPath("/settings/rules/abc", "/settings/rules"));
	assert.ok(!isActiveSettingsPath("/settings/rules-extra", "/settings/rules"));
	assert.ok(!isActiveSettingsPath("/settings/inbox", "/settings/import"));
});
