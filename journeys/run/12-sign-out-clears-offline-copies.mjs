import { APP, expect } from "./harness.mjs";

const URL_TEXT = "localhost:3000/v2/inbox";

const journey = {
	async setup({ device, state }) {
		await device.startSignedIn();
		await device.ensureServiceWorker();
		// What must not survive sign-out: the senders and subjects in the stored inbox, and an opened conversation.
		// Each sender on its own, without the message count a conversation of several shows beside them.
		state.inbox = await device.eval(() => [...document.querySelectorAll("li[data-row]")].flatMap((row) => [window.__j.text(row.querySelector(".row-subject")), ...[...row.querySelectorAll(".row-from > span:not(.row-count):not(.draft-label)")].map(window.__j.text)]).filter((text) => text && text !== "me"));
		const href = await device.eval(() => document.querySelector("li[data-row]").dataset.href);
		await device.goto(`${APP}${href}`);
		await device.until(() => !!document.querySelector("h1.thread-subject"), null, { message: "a conversation to open" });
		await device.goto(`${APP}/v2/inbox`);
		await device.settle();
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
			'Swipe down from the very top edge of the screen twice to open Quick Settings, and tap "Airplane mode" to turn it on',
			async ({ device }) => {
				await device.openQuickSettings();
				await device.setAirplaneMode(true);
			},
		],
		[
			'Close Quick Settings, tap Chrome\'s address bar, type "localhost:3000/v2/inbox" and press Enter',
			async ({ device }) => {
				await device.closeQuickSettings();
				// Stands in for typing into the address bar: `input text` drops characters in Chrome's omnibox and
				// turns the URL into a search (journeys/README.md). A VIEW intent for the URL is the same navigation.
				await device.shell(`am start -a android.intent.action.VIEW -d 'http://${URL_TEXT}' com.android.chrome`);
			},
		],
		[
			'Verify that the page shows "You\'re offline" with a "Try again" button, and that no message subjects or sender names from the inbox are shown',
			async ({ device, state }) => {
				await device.until(() => location.pathname === "/v2/inbox" && /You.re offline/.test(document.body.innerText) && window.__j.byText("button, a", "Try again"), null, { timeout: 15_000, message: `the "You're offline" page with "Try again"` });
				const leaked = await device.eval((names) => names.filter((name) => document.body.innerText.includes(name)), state.inbox);
				expect(leaked.length === 0, `inbox content is still shown after signing out: ${leaked.join(", ")}`);
			},
		],
		[
			'Swipe down from the very top edge of the screen twice to open Quick Settings, and tap "Airplane mode" to turn it off',
			async ({ device }) => {
				await device.openQuickSettings();
				await device.setAirplaneMode(false);
			},
		],
		["Close Quick Settings", ({ device }) => device.closeQuickSettings()],
	],
};

export default journey;
