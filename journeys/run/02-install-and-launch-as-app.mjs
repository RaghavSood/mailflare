import { BLANK, expect, fail, sleep, waitFor } from "./harness.mjs";

const chrome = (n) => n.pkg === "com.android.chrome";
const launcher = (n) => /launcher/.test(n.pkg);
const homeIcon = (n) => launcher(n) && n.clickable && /^Mailflare$/.test(n.desc || n.text);

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
			async ({ device }) => {
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
				// The launcher places a pinned shortcut a moment after confirming it.
				let icon = await device.findNative(homeIcon, { timeout: 8_000, message: "the Mailflare icon" }).catch(() => null);
				for (let page = 0; !icon && page < 3; page++) {
					await device.swipeScreen(device.width * 0.85, device.height * 0.5, device.width * 0.15, device.height * 0.5, 300);
					await sleep(600);
					icon = await device.findNative(homeIcon, { timeout: 3_000, message: "the Mailflare icon" }).catch(() => null);
				}
				if (!icon) {
					// Not on the home screen pages: open the app drawer (swipe up from the bottom), where an installed app is always listed.
					await device.home();
					await sleep(500);
					await device.swipeScreen(device.width / 2, device.height * 0.85, device.width / 2, device.height * 0.2, 300);
					await sleep(800);
					icon = await device.findNative(homeIcon, { timeout: 5_000, message: "the Mailflare icon" }).catch(() => null);
				}
				if (!icon) {
					const pinned = (await device.shell("dumpsys shortcut 2>/dev/null | grep -A3 'Package: com.android.chrome' | grep -iE 'pinned|shortLabel|Mailflare' | head -5")).replace(/\s+/g, " ").trim();
					const labels = (await device.nativeNodes()).filter((n) => launcher(n) && (n.text || n.desc)).map((n) => n.text || n.desc);
					fail(`no "Mailflare" icon on the home screen or in the app drawer (Chrome shortcuts: ${pinned || "none"}; launcher shows: ${labels.slice(0, 30).join(", ")})`);
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
