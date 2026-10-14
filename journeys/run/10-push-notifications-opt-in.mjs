import { APP, expect, fail, waitFor } from "./harness.mjs";

const toast = (text) => [...document.querySelectorAll("#toast .toast")].some((t) => window.__j.visible(t) && window.__j.text(t).includes(text));
const pushItem = () => {
	const el = document.querySelector("#nav [data-push]");
	// Read-only check: on screen in the open drawer (a fixed, empty toast region can sit over it, so not "uncovered").
	return el ? { label: window.__j.text(el.querySelector("[data-push-label]") ?? el), state: el.dataset.state, pressed: el.getAttribute("aria-pressed"), shown: window.__j.visible(el) && document.body.classList.contains("nav-open") } : null;
};

const journey = {
	async setup({ device }) {
		await device.startSignedIn();
		await device.ensureServiceWorker();
		// Chrome has not been asked about notifications for this site yet: back to "Ask".
		const cdp = await device.browser.newBrowserCDPSession();
		await cdp.send("Browser.resetPermissions");
		await cdp.detach().catch(() => {});
		await device.goto(`${APP}/v2/inbox`);
		const state = await device.until(() => {
			const el = document.querySelector("#nav [data-push]");
			return el && el.dataset.state && !["unsupported", "busy"].includes(el.dataset.state) ? { state: el.dataset.state, permission: Notification.permission } : null;
		}, null, { message: "the notification toggle to be ready" });
		expect(state.permission === "default", `notification permission is "${state.permission}", not "Ask"`);
		expect(state.state === "off", `notifications are already "${state.state}" for this device`);
	},
	steps: [
		["Tap the menu button at the top left of the screen", ({ device }) => device.openDrawer()],
		['Tap "Turn on notifications" near the bottom of the drawer', ({ device }) => device.tap({ selector: "#nav [data-push] [data-push-label]", text: "Turn on notifications" })],
		[
			"Tap \"Allow\" in the Chrome dialog asking whether localhost:3000 may send notifications",
			async ({ device }) => {
				const dialog = await device.findNative((n) => n.pkg === "com.android.chrome" && /localhost:3000/.test(n.text) && /notification/i.test(n.text), { message: "Chrome's notification permission dialog for localhost:3000" });
				expect(dialog, "no permission dialog");
				await device.tapNative((n) => n.pkg === "com.android.chrome" && n.clickable && /^Allow$/i.test(n.text), { message: 'the "Allow" button' });
			},
		],
		[
			'Verify that a message reading "Notifications are on for this device." appears',
			async ({ device }) => {
				// Watch every toast, so a failure says what the app said instead (say, the push service refusing).
				await device.eval(() => {
					window.__jToasts = [];
					new MutationObserver(() => {
						const text = document.querySelector("#toast")?.innerText.trim();
						if (text && !window.__jToasts.includes(text)) window.__jToasts.push(text);
					}).observe(document.querySelector("#toast"), { childList: true, subtree: true, characterData: true });
				});
				await device.until(toast, "Notifications are on for this device.", { timeout: 20_000, message: '"Notifications are on for this device."' }).catch(async (error) => {
					const seen = await device.eval(() => window.__jToasts).catch(() => []);
					fail(`${error.message}; the app said: ${seen.length ? seen.map((t) => `"${t}"`).join(", ") : "nothing"}`);
				});
			},
		],
		[
			'Wait 10 seconds for that message to disappear, then verify that the drawer item now reads "Notifications on" and is highlighted',
			async ({ device }) => {
				await waitFor(async () => !(await device.eval(toast, "Notifications are on for this device.")), { timeout: 10_000, message: "the message to disappear" });
				const item = await device.eval(pushItem);
				expect(item?.label === "Notifications on", `the drawer item reads "${item?.label}"`);
				expect(item.shown, "the drawer item is not on screen");
				expect(item.state === "on" && item.pressed === "true", `the drawer item is not highlighted (state ${item.state}, aria-pressed ${item.pressed})`);
			},
		],
		['Tap "Notifications on" to turn notifications off', ({ device }) => device.tap({ selector: "#nav [data-push] [data-push-label]", text: "Notifications on" })],
		[
			'Verify that a message reading "Notifications are off for this device." appears',
			({ device }) => device.until(toast, "Notifications are off for this device.", { timeout: 15_000, message: '"Notifications are off for this device."' }),
		],
		[
			'Wait 10 seconds for that message to disappear, then verify that the drawer item reads "Turn on notifications" again',
			async ({ device }) => {
				await waitFor(async () => !(await device.eval(toast, "Notifications are off for this device.")), { timeout: 10_000, message: "the message to disappear" });
				const item = await device.eval(pushItem);
				expect(item?.label === "Turn on notifications", `the drawer item reads "${item?.label}"`);
				expect(item.shown, "the drawer item is not on screen");
			},
		],
	],
};

export default journey;
