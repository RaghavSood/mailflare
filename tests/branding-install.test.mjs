import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Licensed branding in the installed app: manifest, icon routes, upload checks, v2 head tags. */
const outDir = mkdtempSync(join(tmpdir(), "mailflare-branding-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export * from "./src/lib/branding/install-utils.ts";
			export * from "./src/lib/branding/image-utils.ts";
			export { validateInstallIcons } from "./src/app/api/branding/utils.ts";
			export { renderPage } from "./src/lib/v2/render/layout.ts";
			export { html } from "./src/lib/v2/html.ts";
		`,
		resolveDir: root,
		sourcefile: "branding-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const m = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const licensed = (overrides = {}) => ({ appName: "Mailflare", hasCustomIcon: false, canCustomizeBranding: true, version: "1760000000", ...overrides });
const publicFile = (path) => readFile(join(root, "public", path));

test("without custom branding the manifest is exactly the static file", async () => {
	const staticManifest = JSON.parse(await readFile(join(root, "public/manifest.webmanifest"), "utf8"));
	assert.deepEqual(m.buildWebAppManifest(m.PACKAGED_BRANDING), staticManifest);
	// Licensed but nothing customised, and unlicensed with leftover settings, are the packaged app too.
	assert.deepEqual(m.buildWebAppManifest(licensed()), staticManifest);
	assert.deepEqual(m.buildWebAppManifest({ appName: "Acme", hasCustomIcon: true, canCustomizeBranding: false, version: null }), staticManifest);
	assert.equal(m.hasCustomInstallBranding(m.PACKAGED_BRANDING), false);
});

test("a custom name and icon change only the name and the versioned icon URLs", async () => {
	const staticManifest = JSON.parse(await readFile(join(root, "public/manifest.webmanifest"), "utf8"));
	const manifest = m.buildWebAppManifest(licensed({ appName: "Acme Mail", hasCustomIcon: true }));
	assert.equal(manifest.name, "Acme Mail");
	assert.equal(manifest.short_name, "Acme Mail");
	assert.deepEqual(manifest.icons.map((icon) => `${icon.src} ${icon.sizes} ${icon.purpose}`), [
		"/api/branding/icon/192?v=1760000000 192x192 any",
		"/api/branding/icon/512?v=1760000000 512x512 any",
		"/api/branding/icon/maskable-512?v=1760000000 512x512 maskable",
	]);
	// Same installed app: identity, scope and launch URL are untouched.
	const withoutBrand = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !["name", "short_name", "icons"].includes(key)));
	assert.deepEqual(withoutBrand(manifest), withoutBrand(staticManifest));

	// A custom name with no icon keeps the packaged icon files.
	const nameOnly = m.buildWebAppManifest(licensed({ appName: "Acme Mail" }));
	assert.equal(nameOnly.name, "Acme Mail");
	assert.deepEqual(nameOnly.icons, staticManifest.icons);
});

test("v2 head links: static files unless the install is custom-branded", () => {
	assert.deepEqual(m.brandingHead(m.PACKAGED_BRANDING), {
		appName: "Mailflare",
		manifest: "/manifest.webmanifest",
		appleTouchIcon: "/apple-touch-icon.png",
		favicon: "/favicon.ico",
		brandIcon: null,
	});
	assert.deepEqual(m.brandingHead(licensed({ appName: "Acme" })), {
		appName: "Acme",
		manifest: "/api/branding/manifest?v=1760000000",
		appleTouchIcon: "/apple-touch-icon.png",
		favicon: "/favicon.ico",
		brandIcon: null,
	});
	assert.deepEqual(m.brandingHead(licensed({ appName: "Acme", hasCustomIcon: true })), {
		appName: "Acme",
		manifest: "/api/branding/manifest?v=1760000000",
		appleTouchIcon: "/api/branding/icon/apple-touch?v=1760000000",
		favicon: "/api/branding/icon/192?v=1760000000",
		brandIcon: "/api/branding/icon/192?v=1760000000",
	});
});

test("push notices carry the custom icon only when licensed with one", () => {
	assert.equal(m.pushNotificationIcon(m.PACKAGED_BRANDING), null);
	assert.equal(m.pushNotificationIcon(licensed({ appName: "Acme" })), null);
	assert.equal(m.pushNotificationIcon({ ...licensed({ hasCustomIcon: true }), canCustomizeBranding: false }), null);
	assert.equal(m.pushNotificationIcon(licensed({ hasCustomIcon: true })), "/api/branding/icon/192?v=1760000000");
});

test("icon route decisions: known variants only, versioned URLs are immutable", () => {
	assert.deepEqual(["192", "512", "maskable-512", "apple-touch"].map((id) => m.findInstallIconVariant(id)?.size), [192, 512, 512, 180]);
	for (const id of ["96", "", "../icon-512", "192.png", "constructor"]) assert.equal(m.findInstallIconVariant(id), null);
	assert.deepEqual(m.INSTALL_ICON_VARIANTS.map(m.installIconObjectKey), [
		"branding/app-icon-192.png",
		"branding/app-icon-512.png",
		"branding/app-icon-maskable-512.png",
		"branding/app-icon-apple-touch.png",
	]);
	assert.equal(m.installIconCacheControl(new URL("https://x.test/api/branding/icon/192?v=17")), "public, max-age=31536000, immutable");
	assert.equal(m.installIconCacheControl(new URL("https://x.test/api/branding/icon/192")), "no-cache");
	assert.equal(m.brandingVersion(new Date(1760000000123)), "1760000000");
	assert.equal(m.brandingVersion(null), null);
});

test("every fallback icon exists at the size its variant declares", async () => {
	for (const variant of m.INSTALL_ICON_VARIANTS) {
		const size = m.readPngDimensions(new Uint8Array(await publicFile(variant.staticPath)));
		assert.deepEqual(size, { width: variant.size, height: variant.size }, variant.staticPath);
	}
	assert.equal(m.readPngDimensions(new Uint8Array(await publicFile("favicon.ico"))), null);
	assert.equal(m.readPngDimensions(new Uint8Array(10)), null);
});

test("draw rectangles: contain fits the square, safe-zone keeps every corner inside the 80% circle", () => {
	assert.deepEqual(m.containRect(333, 201, 192), { x: 0, y: 38, width: 192, height: 116 });
	assert.deepEqual(m.containRect(64, 64, 512), { x: 0, y: 0, width: 512, height: 512 });
	for (const [w, h] of [[333, 201], [100, 100], [10, 400]]) {
		const rect = m.safeZoneRect(w, h, 512);
		const radius = Math.hypot(rect.width / 2, rect.height / 2);
		assert.ok(radius <= 512 * 0.4 + 1, `${w}x${h} corners at ${radius}`);
		assert.ok(radius >= 512 * 0.4 - 2, `${w}x${h} uses the safe zone`);
		assert.ok(Math.abs(rect.x + rect.width / 2 - 256) <= 1 && Math.abs(rect.y + rect.height / 2 - 256) <= 1);
	}
	const maskable = m.findInstallIconVariant("maskable-512");
	assert.deepEqual(m.iconDrawRect(maskable, 100, 100), m.safeZoneRect(100, 100, 512));
	assert.deepEqual(m.iconDrawRect(m.findInstallIconVariant("apple-touch"), 300, 200), m.containRect(300, 200, 180));
});

test("opaque icons extend an opaque logo's corner colour, else white", () => {
	assert.equal(m.opaqueBackground([255, 128, 0, 255]), "#ff8000");
	assert.equal(m.opaqueBackground([255, 128, 0, 254]), "#ffffff");
	assert.equal(m.opaqueBackground(null), "#ffffff");
});

test("uploaded install icons: all or none, PNGs of exactly their size", async () => {
	const file = async (path, name = path) => new File([await publicFile(path)], name, { type: "image/png" });
	const form = new FormData();
	assert.deepEqual(await m.validateInstallIcons(form), { icons: null });

	form.set("icon192", await file("icon-192.png"));
	assert.deepEqual(await m.validateInstallIcons(form), { error: "Upload every install icon size or none" });

	form.set("icon512", await file("icon-512.png"));
	form.set("iconMaskable512", await file("icon-maskable-512.png"));
	form.set("appleTouchIcon", await file("icon-192.png"));
	assert.deepEqual(await m.validateInstallIcons(form), { error: "The apple-touch install icon must be a 180x180 PNG" });

	form.set("appleTouchIcon", new File([await publicFile("favicon.ico")], "x.png", { type: "image/png" }));
	assert.deepEqual(await m.validateInstallIcons(form), { error: "The apple-touch install icon must be a 180x180 PNG" });

	form.set("appleTouchIcon", await file("apple-touch-icon.png"));
	const result = await m.validateInstallIcons(form);
	assert.deepEqual(Object.keys(result.icons), ["icon192", "icon512", "iconMaskable512", "appleTouchIcon"]);
});

test("v2 pages use the static manifest without a license and the branded one with it", () => {
	const nav = { counts: { inbox: 0, spam: 0, drafts: 0 }, folders: [], active: { view: "inbox", folderId: null } };
	const base = {
		user: { id: "u1", email: "a@b.c", name: "A" },
		url: new URL("https://mail.test/v2/inbox"),
		mailboxes: [],
		selectedMailboxId: null,
		theme: "system",
		shortcutsEnabled: true,
		vapidPublicKey: null,
	};
	const page = (ctx) => String(m.renderPage(ctx, { title: "Inbox", main: m.html`<main id="main"></main>`, nav }));

	for (const branding of [undefined, null, m.PACKAGED_BRANDING, { appName: "Acme", hasCustomIcon: true, canCustomizeBranding: false, version: null }]) {
		const out = page({ ...base, branding });
		assert.match(out, /<link rel="manifest" href="\/manifest\.webmanifest">/);
		assert.match(out, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
		assert.match(out, /<link rel="icon" href="\/favicon\.ico">/);
		assert.match(out, /<meta name="apple-mobile-web-app-title" content="Mailflare">/);
		assert.match(out, /<span class="brand-name">Mailflare<\/span>/);
		assert.match(out, /<span class="brand-mark">/);
	}

	const out = page({ ...base, branding: licensed({ appName: "Acme <Mail>", hasCustomIcon: true }) });
	assert.match(out, /<link rel="manifest" href="\/api\/branding\/manifest\?v=1760000000">/);
	assert.match(out, /<link rel="apple-touch-icon" href="\/api\/branding\/icon\/apple-touch\?v=1760000000">/);
	assert.match(out, /<link rel="icon" href="\/api\/branding\/icon\/192\?v=1760000000">/);
	assert.match(out, /<meta name="apple-mobile-web-app-title" content="Acme &lt;Mail&gt;">/);
	assert.match(out, /<span class="brand-name">Acme &lt;Mail&gt;<\/span>/);
	assert.match(out, /<img class="brand-mark" src="\/api\/branding\/icon\/192\?v=1760000000"/);
});
