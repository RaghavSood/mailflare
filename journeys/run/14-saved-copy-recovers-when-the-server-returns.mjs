import { expect, sleep, waitFor } from "./harness.mjs";

const banner = () => {
	const el = document.querySelector("[data-offline-banner]");
	return el && window.__j.shown(el) ? window.__j.text(el) : null;
};

// The conversation opened in the first step, with its message text (the page may be the stored copy).
const conversationShown = ({ subject, text }) => {
	const body = [...document.querySelectorAll(".msg.is-expanded .msg-content")].at(-1);
	return !!window.__j.byText("h1.thread-subject", subject) && !!body && window.__j.text(body).includes(text.slice(0, 40));
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
				state.path = await device.eval(() => location.pathname);
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
			"Make the Mailflare server unreachable without turning on Airplane mode (on an emulator, cut the `adb reverse` tunnel to the server and any connection already open through it)",
			async ({ device }) => {
				// The runner's relay refuses connections and closes the open ones; the device keeps its network.
				device.setRelayOffline(true);
				expect(!(await device.airplaneMode()), "Airplane mode is on");
				await device.until(async () => navigator.onLine && (await fetch("/login", { cache: "no-store" }).then(() => false, () => true)), null, {
					message: "the page to be online with the server out of reach",
				});
			},
		],
		["Tap the first conversation in the inbox list", ({ device }) => device.tap("li[data-row] .row-subject", { effect: () => location.pathname.startsWith("/v2/inbox/") || /You.re offline/.test(document.body.innerText), effectTimeout: 8_000 })],
		[
			'Verify that the conversation\'s subject and message text are shown, and that the banner at the top reads "Couldn\'t reach Mailflare" followed by "copy from" and a time',
			async ({ device, state }) => {
				await device.until(({ subject, text }) => {
					if (/You.re offline/.test(document.body.innerText)) throw new Error('the "You\'re offline" page is shown');
					const body = [...document.querySelectorAll(".msg.is-expanded .msg-content")].at(-1);
					return window.__j.byText("h1.thread-subject", subject) && body && window.__j.text(body).includes(text.slice(0, 40));
				}, state, { timeout: 15_000, message: `"${state.subject}" and its message text from the stored copy` }).catch((error) => {
					const errorPage = device.pages().find((p) => p.url().startsWith("chrome-error:"));
					throw errorPage ? new Error(`Chrome shows its error page (${errorPage.url()})`) : error;
				});
				// "Reconnecting" until the first try at the server has failed.
				const text = await device.until(() => {
					const el = document.querySelector("[data-offline-banner]");
					return el && window.__j.shown(el) && el.getBoundingClientRect().top < 120 && /^Couldn.t reach Mailflare\b.*copy from \d{1,2}:\d{2}/.test(window.__j.text(el)) && window.__j.text(el);
				}, null, { timeout: 15_000, message: 'the banner at the top to read "Couldn\'t reach Mailflare · copy from <time>"' }).catch(async (error) => {
					throw new Error(`${error.message}; it reads "${await device.eval(banner)}"`);
				});
				device.log(`  banner: ${text}`);
				// Toasts fade out, so the next check could miss one shown in between: record each one from now on.
				await device.eval(() => {
					window.__toasts = [];
					const region = document.querySelector("#toast");
					new MutationObserver(() => region.querySelectorAll(".toast").forEach((t) => window.__toasts.push(window.__j.text(t)))).observe(region, { childList: true, subtree: true, characterData: true });
				});
			},
		],
		["Wait 15 seconds", () => sleep(15_000)],
		[
			'Verify that the banner still reads "Couldn\'t reach Mailflare" and that no error message or browser error page is shown',
			async ({ device, state }) => {
				const text = await device.eval(banner);
				expect(/^Couldn.t reach Mailflare\b/.test(text ?? ""), `the banner reads "${text}"`);
				const toasts = await device.eval(() => [...(window.__toasts ?? ["(the page was reloaded)"]), ...[...document.querySelectorAll("#toast .toast")].map(window.__j.text)].filter(Boolean));
				expect(toasts.length === 0, `an error message was shown: "${[...new Set(toasts)].join(" | ")}"`);
				const errorPage = device.pages().find((p) => p.url().startsWith("chrome-error:"));
				expect(!errorPage, `Chrome shows its error page (${errorPage?.url()})`);
				expect(await device.eval(conversationShown, state), `"${state.subject}" is no longer shown`);
			},
		],
		[
			"Make the Mailflare server reachable again and wait 30 seconds",
			async ({ device }) => {
				device.setRelayOffline(false);
				// Up to 30 s; stops early once the banner has gone.
				await waitFor(async () => !(await device.eval(banner).catch(() => "unknown")), { timeout: 30_000 }).catch(() => {});
			},
		],
		[
			'Verify that the banner is no longer shown, the "Search mail" field is back at the top, and the same conversation is still shown',
			async ({ device, state }) => {
				const text = await device.eval(banner);
				const now = await device.eval(() => ({ path: location.pathname, cachedAt: document.body.dataset.cachedAt ?? null }));
				device.log(`  after the server came back: ${JSON.stringify({ ...now, banner: text })}`);
				expect(!text, `the banner still reads "${text}" after the server came back`);
				const search = await device.eval(() => {
					const el = document.querySelector('input[placeholder="Search mail"]');
					return !!el && window.__j.shown(el) && el.getBoundingClientRect().top < 120;
				});
				expect(search, 'the "Search mail" field is not shown at the top');
				expect(now.path === state.path, `the page is ${now.path}, not ${state.path}`);
				expect(await device.eval(conversationShown, state), `"${state.subject}" and its message text are not shown`);
			},
		],
	],
};

export default journey;
