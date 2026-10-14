import { expect, waitFor } from "./harness.mjs";

const banner = () => {
	const el = document.querySelector("[data-offline-banner]");
	return el && window.__j.shown(el) ? window.__j.text(el) : null;
};

const journey = {
	async setup({ device }) {
		await device.startSignedIn();
		await device.ensureServiceWorker();
	},
	steps: [
		[
			"Tap the first conversation in the inbox list and wait for it to load",
			async ({ device, state }) => {
				state.subject = await device.eval(() => window.__j.text(document.querySelector("li[data-row] .row-subject")));
				await device.tap("li[data-row] .row-subject", { effect: () => location.pathname.startsWith("/v2/inbox/"), effectTimeout: 8_000 });
				state.text = await device.until((subject) => {
					if (!window.__j.byText("h1.thread-subject", subject)) return null;
					const body = [...document.querySelectorAll(".msg.is-expanded .msg-content")].at(-1);
					return body && window.__j.text(body);
				}, state.subject, { timeout: 15_000, message: `"${state.subject}" and its message text to load` });
			},
		],
		[
			"Press the Android Back button once to return to the inbox",
			async ({ device }) => {
				await device.back();
				await device.until(() => location.pathname === "/v2/inbox" && document.querySelector("li[data-row]"), null, { message: "the inbox after Back" });
			},
		],
		[
			'Swipe down from the very top edge of the screen twice to open Quick Settings, and tap "Airplane mode" to turn it on',
			async ({ device }) => {
				await device.openQuickSettings();
				await device.setAirplaneMode(true);
			},
		],
		["Swipe up from the bottom of Quick Settings, or press the Back button, to close Quick Settings", ({ device }) => device.closeQuickSettings()],
		[
			'Tap the menu button at the top left of the screen and tap "Inbox" in the drawer',
			async ({ device }) => {
				await device.until(() => !navigator.onLine, null, { message: "the page to see the device offline" });
				await device.drawerTo("Inbox");
			},
		],
		[
			'Verify that a banner starting with "Offline" is shown at the top of the page and that the inbox message list is still shown',
			async ({ device }) => {
				const text = await device.until(banner, null, { timeout: 15_000, message: "the offline banner" });
				expect(text.startsWith("Offline"), `the banner reads "${text}"`);
				await device.until(() => location.pathname === "/v2/inbox" && [...document.querySelectorAll("li[data-row]")].some(window.__j.shown) && document.querySelector("[data-offline-banner]").getBoundingClientRect().top < 120, null, { message: "the inbox list with the banner at the top" });
			},
		],
		[
			'Verify that the "Search mail" field is no longer shown at the top: on a phone the "Offline" banner takes its place, because search runs on the server',
			async ({ device }) => {
				const search = await device.eval(() => window.__j.shown(document.querySelector('input[placeholder="Search mail"]')));
				expect(!search, 'the "Search mail" field is still shown');
			},
		],
		["Tap the first conversation in the inbox list", ({ device }) => device.tap("li[data-row] .row-subject", { effect: () => location.pathname.startsWith("/v2/inbox/") || /You.re offline/.test(document.body.innerText), effectTimeout: 8_000 })],
		[
			'Verify that the conversation\'s subject and message text are shown, and that no browser error page or "You\'re offline" page is shown',
			async ({ device, state }) => {
				await device.until(({ subject, text }) => {
					if (/You.re offline/.test(document.body.innerText)) throw new Error('the "You\'re offline" page is shown');
					const body = [...document.querySelectorAll(".msg.is-expanded .msg-content")].at(-1);
					return window.__j.byText("h1.thread-subject", subject) && body && window.__j.text(body).includes(text.slice(0, 40));
				}, state, { timeout: 15_000, message: `"${state.subject}" and its message text offline` }).then(async () => {
					// For the report: whether this is the stored copy, which is what #20 was about.
					state.offlineCopy = await device.eval(() => ({ cachedAt: document.body.dataset.cachedAt ?? null, banner: document.querySelector("[data-offline-banner]")?.innerText.trim() ?? null }));
				}, (error) => {
					const errorPage = device.pages().find((p) => p.url().startsWith("chrome-error:"));
					throw errorPage ? new Error(`Chrome shows its error page (${errorPage.url()})`) : error;
				});
			},
		],
		[
			'Swipe down from the very top edge of the screen twice to open Quick Settings, and tap "Airplane mode" to turn it off',
			async ({ device }) => {
				await device.openQuickSettings();
				await device.setAirplaneMode(false);
			},
		],
		[
			"Close Quick Settings and wait 10 seconds",
			async ({ device }) => {
				await device.closeQuickSettings();
				// Up to 10 s; stops early once the banner has gone.
				await waitFor(async () => !(await device.eval(banner).catch(() => "unknown")), { timeout: 10_000, message: "" }).catch(() => {});
			},
		],
		[
			'Verify that the "Offline" banner is no longer shown',
			async ({ device, state }) => {
				const text = await device.eval(banner);
				const now = await device.eval(() => ({ path: location.pathname, cachedAt: document.body.dataset.cachedAt ?? null }));
				device.log(`  offline copy: ${JSON.stringify(state.offlineCopy)}; after reconnecting: ${JSON.stringify({ ...now, banner: text })}`);
				expect(!text, `the banner still reads "${text}" after reconnecting`);
			},
		],
	],
};

export default journey;
