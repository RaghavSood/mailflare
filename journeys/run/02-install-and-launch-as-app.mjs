import { BLANK, expect, fail, sleep, waitFor } from "./harness.mjs";

const chrome = (n) => n.pkg === "com.android.chrome";
const launcher = (n) => /launcher/.test(n.pkg);
const homeIcon = (n) => launcher(n) && n.clickable && /^Mailflare$/.test(n.desc || n.text);

/** What the launcher shows now (one home screen page, or the app drawer), top to bottom. */
const launcherNodes = async (device) => (await device.nativeNodes()).filter((n) => launcher(n) && n.bounds);
const labelsOf = (nodes) => nodes.filter((n) => n.desc || n.text).map((n) => n.desc || n.text);

/**
 * Where the launcher put Chrome's new shortcut: the home screen page index it logged when it placed it
 * (null until then). Accepting the pin only queues the shortcut; the launcher places it when it next
 * comes to the front, on the first page with room (page 1 on the CI image, beside "At a glance").
 */
async function placedOnPage(device, since) {
	const log = await device.shell(`logcat -d -v epoch -T ${since}.000 -s AddWorkspaceItemsTask:D 2>/dev/null`);
	const placed = [...log.matchAll(/targetComponent=ComponentInfo\{com\.android\.chrome\/[^}]*\} screen=(\d+)/g)].at(-1);
	return placed ? Number(placed[1]) : null;
}

/**
 * Shows home screen page `index`: Home (from the home screen it goes back to the first page), then one
 * swipe left per page. A swipe the launcher drops (it ignores touches while it settles) leaves the same
 * page on screen, so each swipe is checked and made again until the page changes. Returns its labels.
 */
async function showHomePage(device, index) {
	await device.home();
	await sleep(400);
	await device.home();
	let nodes = await waitFor(async () => {
		const now = await launcherNodes(device);
		return labelsOf(now).length ? now : null;
	}, { timeout: 10_000, message: "the launcher's home screen" });
	for (let page = 0; page < index; page++) {
		let moved = null;
		for (let swipe = 1; swipe <= 3 && !moved; swipe++) {
			await device.swipeScreen(device.width * 0.85, device.height * 0.5, device.width * 0.15, device.height * 0.5, 300);
			moved = await waitFor(async () => {
				const now = await launcherNodes(device);
				return labelsOf(now).length && labelsOf(now).join("|") !== labelsOf(nodes).join("|") ? now : null;
			}, { timeout: 3_000, interval: 300, message: `home screen page ${page + 2}` }).catch(() => null);
		}
		if (!moved) return { nodes, reached: page };
		nodes = moved;
	}
	return { nodes, reached: index };
}

const journey = {
	async setup({ device }) {
		// Installable: signed in, on the v2 inbox, with the service worker in control.
		await device.startSignedIn();
		await device.ensureServiceWorker();
	},
	async teardown({ device }) {
		// Leave the installed app, so the next journey starts in a Chrome tab again.
		await device.shell("am force-stop com.android.chrome");
		await device.shell(`am start -a android.intent.action.VIEW -d '${BLANK}' com.android.chrome`);
		await device.page({ timeout: 30_000 });
	},
	steps: [
		[
			"Tap Chrome's three-dot menu button at the top right of the screen",
			async ({ device }) => {
				await device.tapNative((n) => chrome(n) && /menu_button$/.test(n.id), { message: "Chrome's menu button" });
				await device.findNative((n) => chrome(n) && /menu_item_text$/.test(n.id), { message: "Chrome's menu" });
			},
		],
		[
			'Tap the menu item named "Add to home screen" or "Install app"',
			async ({ device }) => {
				await device.tapNative((n) => chrome(n) && /^(Add to home screen|Install app)$/i.test(n.text), { message: '"Add to home screen" or "Install app" in the menu' });
				// Chrome 133 first asks how to add the app (Install, or a plain shortcut): installing is what the journey means.
				const choice = await device.findNative((n) => chrome(n) && (/option_text_install$/.test(n.id) || /app_name$/.test(n.id)), { message: "Chrome's install sheet or dialog" });
				if (/option_text_install$/.test(choice.id)) await device.tapNative((n) => chrome(n) && /option_text_install$/.test(n.id), { message: 'the "Install" option' });
			},
		],
		[
			'Verify that a dialog offers to install or add "Mailflare" and shows the blue open-envelope icon',
			async ({ device }) => {
				const name = await device.findNative((n) => chrome(n) && /app_name$/.test(n.id), { message: "the install dialog" });
				expect(name.text === "Mailflare", `the install dialog names "${name.text}"`);
				const nodes = await device.nativeNodes();
				expect(nodes.some((n) => chrome(n) && /positive_button$/.test(n.id) && /^(Install|Add)$/i.test(n.text)), 'the dialog has no "Install" or "Add" button');
				const icon = nodes.find((n) => chrome(n) && /\/icon$/.test(n.id));
				expect(icon && icon.bounds.x2 - icon.bounds.x1 > 40, "the dialog shows no app icon");
				// The envelope icon on its pale blue tile: blue clearly dominates the icon's pixels.
				const { r, g, b } = await device.meanColour(icon.bounds);
				expect(b > r + 25 && b >= g, `the app icon is not blue (mean RGB ${[r, g, b].map(Math.round).join(", ")})`);
			},
		],
		[
			'Tap "Install" (or "Add") in that dialog, and tap "Add" or "Add automatically" if a second confirmation appears',
			async ({ device, state }) => {
				// The launcher's log from here on says where it places the shortcut (see placedOnPage).
				state.since = Number((await device.shell("date +%s")).trim()) - 2;
				await device.tapNative((n) => chrome(n) && /positive_button$/.test(n.id), { message: 'the "Install" button' });
				// The launcher asks to confirm the new shortcut; on a slow emulator that can take a while to appear.
				const isConfirm = (n) => launcher(n) && n.clickable && /^(Add|Add automatically|Add to home screen)$/i.test(n.text);
				const confirm = await device.findNative(isConfirm, { timeout: 15_000, message: "the launcher's confirmation" }).catch(() => null);
				if (confirm) await device.tapScreen((confirm.bounds.x1 + confirm.bounds.x2) / 2, (confirm.bounds.y1 + confirm.bounds.y2) / 2);
				else device.log(`  no launcher confirmation; on screen: ${(await device.nativeNodes()).filter((n) => n.text || n.desc).map((n) => n.text || n.desc).slice(0, 15).join(" | ")}`);
				await waitFor(async () => !(await device.nativeNodes()).some((n) => launcher(n) && /^(Add automatically|Add to home screen)$/i.test(n.text) && n.clickable), { timeout: 6_000, message: "the confirmation to close" });
			},
		],
		[
			"Press the Home button to go to the Android home screen",
			async ({ device }) => {
				await device.home();
				await waitFor(async () => /Launcher/.test(await device.shell("dumpsys window | grep -m1 mCurrentFocus 2>/dev/null")), { timeout: 5_000, message: "the home screen" });
			},
		],
		[
			'Verify that a "Mailflare" icon with a blue envelope is on the home screen; swipe left or open the app drawer to find it if it is not on the first page',
			async ({ device, state }) => {
				// The icon is on the page the launcher logs once it has placed the shortcut, which it does
				// after coming to the front, so look there until it shows up (or the deadline passes).
				const started = Date.now();
				const at = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
				let icon = (await device.nativeNodes()).find((n) => n.bounds && homeIcon(n)) ?? null;
				const seen = [icon ? `the screen in front at ${at()}: the icon` : `the screen in front at ${at()}: no icon`];
				let page = null;
				let placedAt = null;
				const deadline = Date.now() + 30_000;
				while (!icon && Date.now() < deadline) {
					if (page === null) {
						page = await placedOnPage(device, state.since);
						if (page !== null) placedAt = at();
					}
					// Until the launcher says where, look through the first pages.
					const target = page ?? (seen.length - 1) % 3;
					const shown = await showHomePage(device, target);
					icon = shown.nodes.find(homeIcon) ?? null;
					seen.push(`page ${shown.reached + 1} at ${at()}${shown.reached < target ? ` (page ${target + 1} wanted; the swipe did not move)` : ""}: ${icon ? "the icon" : labelsOf(shown.nodes).slice(0, 12).join(", ") || "nothing"}`);
					if (!icon) await sleep(1_000);
				}
				const placement = page === null ? "no placement logged" : `placed on page ${page + 1} (read at ${placedAt})`;
				if (icon) device.log(`  launcher log: ${placement}; looked at ${seen.join("; ")}`);
				let drawer = null;
				if (!icon) {
					// Not on the home screen pages: open the app drawer (swipe up from the bottom). A Chrome-hosted
					// web app (Chrome mints no WebAPK for localhost) is only a shortcut, so it is not listed there.
					await device.home();
					await sleep(500);
					await device.swipeScreen(device.width / 2, device.height * 0.85, device.width / 2, device.height * 0.2, 300);
					await sleep(800);
					icon = await device.findNative(homeIcon, { timeout: 5_000, message: "the Mailflare icon" }).catch(() => null);
					drawer = labelsOf(await launcherNodes(device)).slice(0, 20).join(", ");
				}
				if (!icon) {
					const pinned = (await device.shell("dumpsys shortcut 2>/dev/null | grep -A3 'Package: com.android.chrome' | grep -iE 'pinned|shortLabel|Mailflare' | head -5")).replace(/\s+/g, " ").trim();
					const queued = (await device.shell(`logcat -d -v epoch -T ${state.since}.000 -s ItemInstallQueue:D AddWorkspaceItemsTask:D 2>/dev/null | grep -cE 'to queue|screen='`)).trim();
					fail(`no "Mailflare" icon on the home screen or in the app drawer (Chrome shortcuts: ${pinned || "none"}; launcher log: ${page === null ? `no placement logged (${queued} queue/placement lines)` : placement}; looked at ${seen.join("; ")}; app drawer: ${drawer || "not opened"})`);
				}
				// The label sits under the image; the image is the top part of the icon's box.
				const imageBottom = icon.bounds.y1 + (icon.bounds.x2 - icon.bounds.x1) * 0.9;
				const { r, g, b } = await device.meanColour({ ...icon.bounds, y2: Math.round(imageBottom) });
				expect(b > r + 10 && b >= g - 5, `the home screen icon is not blue (mean RGB ${[r, g, b].map(Math.round).join(", ")})`);
				state.icon = icon;
			},
		],
		[
			'Tap the "Mailflare" icon and wait for the app to open',
			async ({ device, state }) => {
				const { x1, y1, x2, y2 } = state.icon.bounds;
				await device.tapScreen((x1 + x2) / 2, (y1 + y2) / 2);
				await waitFor(async () => /WebappActivity|WebApkActivity/.test(await device.shell("dumpsys window | grep -m1 mCurrentFocus 2>/dev/null")), { timeout: 15_000, message: "the installed app to open" });
			},
		],
		[
			"Verify that the app opens without Chrome's address bar or tab buttons, and shows the Mailflare inbox with the \"Search mail\" field and the message list",
			async ({ device }) => {
				const nodes = await device.nativeNodes();
				const chromeUi = nodes.filter((n) => chrome(n) && /url_bar|tab_switcher_button|location_bar/.test(n.id));
				expect(chromeUi.length === 0, `Chrome's ${chromeUi.map((n) => n.id.split("/").pop()).join(", ")} is shown`);
				const app = await waitFor(async () => {
					for (const p of device.pages()) {
						const standalone = await p.evaluate(() => matchMedia("(display-mode: standalone)").matches).catch(() => false);
						if (standalone) return p;
					}
					return null;
				}, { timeout: 15_000, message: "a page in standalone display mode" });
				await waitFor(() => app.evaluate(() => {
					const shown = (el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().bottom > 0;
					return location.pathname === "/v2/inbox" && shown(document.querySelector('input[placeholder="Search mail"]')) && shown(document.querySelector("li[data-row]"));
				}), { timeout: 15_000, message: 'the inbox with "Search mail" and the message list in the app' });
			},
		],
	],
};

export default journey;
