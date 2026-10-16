import { APP, BLANK, LOGIN, expect, fail, waitFor } from "./harness.mjs";
import { appInFront, chromeBrowserUi, findHomeIcon, installFromMenu } from "./installed-app.mjs";

/** The page in the installed app's window: the one in standalone display mode. */
async function appPage(device) {
	return waitFor(async () => {
		if (!device.browser) await device.connect();
		for (const p of device.pages()) {
			if (await p.evaluate(() => matchMedia("(display-mode: standalone)").matches).catch(() => false)) return p;
		}
		return null;
	}, { timeout: 20_000, message: "a page in standalone display mode" });
}

const journey = {
	async setup({ device, state }) {
		await device.startSignedIn();
		await device.ensureServiceWorker();
		// Installed already (journey 02 on this device; the launcher puts it on the first page), or install
		// it the way 02 does. The runner's `pm clear` of Chrome removes the shortcut, so usually it is not.
		const { icon } = await findHomeIcon(device, { pages: 1 });
		await device.shell("am start -n com.android.chrome/com.google.android.apps.chrome.Main");
		await waitFor(async () => /ChromeTabbedActivity/.test(await device.shell("dumpsys window | grep -m1 mCurrentFocus 2>/dev/null")), { timeout: 10_000, message: "Chrome back in front" });
		if (!icon) {
			device.log("  Mailflare is not on the home screen; installing it from Chrome's menu");
			state.since = await installFromMenu(device);
		}
		await device.goto(`${APP}/v2/inbox`);
		await device.settle();
	},
	async teardown({ device }) {
		// Leave the installed app, so the next journey starts in a Chrome tab again (as journey 02 does).
		await device.shell("am force-stop com.android.chrome");
		await device.shell(`am start -a android.intent.action.VIEW -d '${BLANK}' com.android.chrome`);
		device.browser = null;
		await device.page({ timeout: 60_000 });
	},
	steps: [
		[
			'Tap the menu button at the top left of the screen and tap "Switch to classic" at the bottom of the drawer',
			async ({ device }) => {
				await device.openDrawer();
				await device.tap({ selector: "#nav .nav-label", text: "Switch to classic" }, { effect: () => location.pathname === "/inbox", effectTimeout: 15_000 });
				await device.settle();
			},
		],
		[
			"Tap the round account avatar at the top right of the screen",
			({ device }) => device.tap('button[aria-label="Open account menu"]', { effect: () => [...document.querySelectorAll('[role="menuitem"], button, a')].some((el) => window.__j.shown(el) && window.__j.text(el) === "Sign out") }),
		],
		[
			'Tap "Sign out" at the bottom of the menu that opens',
			({ device }) => device.tap({ selector: '[role="menuitem"], button, a', text: "Sign out" }, { effect: () => location.pathname === "/login", effectTimeout: 15_000 }),
		],
		[
			"Verify that the Mailflare sign-in page is shown",
			({ device }) => device.until(() => location.pathname === "/login" && window.__j.byText("h1,h2", "Sign in") && window.__j.shown(document.querySelector("input[type=password]")), null, { timeout: 15_000, message: "the sign-in page" }),
		],
		[
			"Press the Home button to go to the Android home screen",
			async ({ device }) => {
				await device.home();
				await waitFor(async () => /Launcher/.test(await device.shell("dumpsys window | grep -m1 mCurrentFocus 2>/dev/null")), { timeout: 5_000, message: "the home screen" });
			},
		],
		[
			'Tap the "Mailflare" icon on the home screen (swipe left to find it if it is not on the first page) and wait for the app to open',
			async ({ device, state }) => {
				// A shortcut pinned in setup is placed when the launcher next comes to the front: allow it a while.
				const { icon, seen } = await findHomeIcon(device, { since: state.since ?? null, timeout: state.since ? 30_000 : 0 });
				if (!icon) fail(`no "Mailflare" icon on the home screen (looked at ${seen.join("; ")})`);
				const { x1, y1, x2, y2 } = icon.bounds;
				await device.tapScreen((x1 + x2) / 2, (y1 + y2) / 2);
				await waitFor(() => appInFront(device), { timeout: 15_000, message: "the installed app to open" });
				// Only the app's page from here on: the Chrome tab behind it could otherwise be taken for the page in front.
				const app = await appPage(device);
				for (const p of device.pages()) if (p !== app && p.url().startsWith(APP)) await p.close().catch(() => {});
			},
		],
		[
			"Verify that the app opens in its own window without Chrome's tab buttons or editable address bar, and shows the Mailflare sign-in page with an Email field and a Password field",
			async ({ device }) => {
				expect(await appInFront(device), "the installed app's window is not in front");
				const ui = await chromeBrowserUi(device);
				expect(ui.length === 0, `Chrome's ${ui.join(", ")} is shown`);
				await device.until(() => {
					const { byText, shown } = window.__j;
					return location.pathname === "/login" && byText("h1,h2", "Sign in") && shown(document.querySelector("input[type=email]")) && shown(document.querySelector("input[type=password]"));
				}, null, { timeout: 20_000, message: 'the sign-in page with Email and Password fields in the app' });
			},
		],
		[
			'Tap the Email field and type "admin@example.com"',
			async ({ device }) => {
				await device.focus("input[type=email]");
				await device.typeInto("input[type=email]", LOGIN.email);
			},
		],
		[
			'Tap the Password field and type "demo-password-change-me"',
			async ({ device }) => {
				await device.focus("input[type=password]");
				await device.typeInto("input[type=password]", LOGIN.password);
			},
		],
		[
			'Tap the "Sign in" button and wait for the next page to finish loading',
			async ({ device }) => {
				await device.tap({ selector: "button", text: "Sign in" }, { effect: () => location.pathname !== "/login" || !!document.querySelector("form button[disabled], [role=alert]"), effectTimeout: 15_000 });
				await device.until(() => location.pathname !== "/login" && document.readyState === "complete", null, { timeout: 20_000, message: "the page after sign-in to load" });
			},
		],
		[
			'Verify that the app window, still without Chrome\'s tab buttons or address bar, shows the Mailflare inbox with the "Search mail" field and the message list',
			async ({ device }) => {
				expect(await appInFront(device), "the installed app's window is no longer in front");
				await appPage(device);
				await device.until(() => {
					const shown = (el) => el && window.__j.visible(el);
					return location.pathname === "/v2/inbox" && shown(document.querySelector('input[placeholder="Search mail"]')) && shown(document.querySelector("li[data-row]"));
				}, null, { timeout: 15_000, message: 'the v2 inbox with "Search mail" and the message list in the app' });
				const ui = await chromeBrowserUi(device);
				expect(ui.length === 0, `Chrome's ${ui.join(", ")} is shown`);
			},
		],
	],
};

export default journey;
