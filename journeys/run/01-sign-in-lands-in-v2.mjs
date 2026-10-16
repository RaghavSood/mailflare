import { APP, LOGIN, expect } from "./harness.mjs";

const journey = {
	async setup({ device }) {
		await device.goto(`${APP}/login`);
		await device.signOut();
		await device.goto(`${APP}/v2/inbox`);
		await device.until(() => location.pathname === "/login", null, { message: "the signed-out /v2/inbox to show the sign-in page" });
	},
	// Chrome offers to save the password after signing in; its bubble would cover the next journey's toolbar.
	teardown: ({ device }) => device.dismissChromeMessage(/^Save password/),
	steps: [
		[
			'Verify that the page shows a "Sign in" heading with an Email field and a Password field',
			({ device }) =>
				device.until(() => {
					const { byText, shown } = window.__j;
					return byText("h1,h2", "Sign in") && shown(document.querySelector("input[type=email]")) && shown(document.querySelector("input[type=password]"));
				}, null, { message: 'a "Sign in" heading with Email and Password fields' }),
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
			'Verify that the address bar shows a URL ending in "/v2/inbox"',
			async ({ device }) => {
				const url = (await device.page()).url();
				expect(url.endsWith("/v2/inbox"), `the URL is ${url}`);
			},
		],
		[
			'Verify that the page shows a "Search mail" field at the top, an "Inbox" heading above the message list, and at least one message row with a sender name and a subject',
			({ device }) =>
				device.until(() => {
					const { shown, text } = window.__j;
					const search = document.querySelector('input[placeholder="Search mail"]');
					const heading = [...document.querySelectorAll(".tb-title")].find((el) => shown(el) && text(el) === "Inbox");
					const row = [...document.querySelectorAll("li[data-row]")].find(shown);
					if (!shown(search) || search.getBoundingClientRect().top > 120) return null;
					if (!heading || !row || heading.getBoundingClientRect().bottom > row.getBoundingClientRect().top) return null;
					return text(row.querySelector(".row-from")) && text(row.querySelector(".row-subject"));
				}, null, { message: 'the "Search mail" field, the "Inbox" heading and a message row with sender and subject' }),
		],
		[
			"Verify that a round compose button with a pencil icon is shown at the bottom right of the screen",
			({ device }) =>
				device.until(() => {
					const fab = [...document.querySelectorAll(".fab")].find(window.__j.shown);
					if (!fab) return null;
					const r = fab.getBoundingClientRect();
					// Lucide's pencil icon; the button is a rounded Material-style FAB.
					const pencil = fab.querySelector('svg path[d^="M21.174 6.812"]');
					const rounded = parseFloat(getComputedStyle(fab).borderRadius) >= r.width / 4;
					return rounded && pencil && r.right > innerWidth * 0.75 && r.bottom > innerHeight * 0.75;
				}, null, { message: "a round compose button with an icon at the bottom right" }),
		],
		[
			"Verify that the page fits the screen width: no message row is cut off on the right and there is no horizontal scrollbar",
			({ device }) =>
				device.until(() => {
					const rows = [...document.querySelectorAll("li[data-row]")].filter(window.__j.visible);
					return rows.length > 0 && document.documentElement.scrollWidth <= innerWidth && rows.every((row) => row.getBoundingClientRect().right <= innerWidth + 0.5);
				}, null, { message: "every row to fit inside the screen width with no horizontal overflow" }),
		],
	],
};

export default journey;
