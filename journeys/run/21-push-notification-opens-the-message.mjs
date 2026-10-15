import { APP, expect, fail, sleep, waitFor } from "./harness.mjs";

const SENDER = "Journey Sender 1";
const toast = (text) => [...document.querySelectorAll("#toast .toast")].some((t) => window.__j.visible(t) && window.__j.text(t).includes(text));
const shade = (n) => n.pkg === "com.android.systemui";

/** Whether a notification showing `text` is posted (shown in the shade or not), from the notification service. */
async function posted(device, text) {
	return (await device.shell("dumpsys notification --noredact 2>/dev/null | grep -E 'android\\.(title|text|bigText)='")).includes(text);
}

/** Notifications off for this browser, as the drawer's toggle turns them off (Chrome's permission stays as it is). */
async function notificationsOff(device) {
	await device.eval(async () => {
		const subscription = await (await navigator.serviceWorker.getRegistration("/v2/"))?.pushManager.getSubscription();
		if (!subscription) return;
		await fetch("/v2/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
		await subscription.unsubscribe();
	});
}

const journey = {
	// A cold start of Chrome on a cleared profile took up to a minute on a busy host.
	setupTimeout: 180_000,
	async setup({ device, state }) {
		await device.startSignedIn();
		// Journey 10, earlier in the same run, leaves Chrome allowing notifications. DevTools cannot put that back
		// (Browser.resetPermissions only drops its own overrides), and a push to a subscription made seconds
		// after 10's unsubscribe on a new profile was never delivered (2 of 2 runs): start from a fresh profile.
		if ((await device.eval(() => Notification.permission)) !== "default") {
			device.log("  notifications are already allowed for localhost:3000; clearing Chrome's data");
			await device.startChrome({ fresh: true });
			await device.startSignedIn();
		}
		await device.ensureServiceWorker();
		await notificationsOff(device);
		await device.goto(`${APP}/v2/inbox`);
		const toggle = await device.until(() => {
			const el = document.querySelector("#nav [data-push]");
			return el && el.dataset.state && !["unsupported", "busy"].includes(el.dataset.state) ? { state: el.dataset.state, permission: Notification.permission } : null;
		}, null, { message: "the notification toggle to be ready" });
		expect(toggle.permission === "default", `notification permission is "${toggle.permission}", not "Ask"`);
		expect(toggle.state === "off", `notifications are already "${toggle.state}" for this device`);
		// Subjects no earlier run used, so the shade and the list cannot match an old message.
		const stamp = Date.now().toString(36);
		state.first = `Push journey ${stamp} closed`;
		state.second = `Push journey ${stamp} open`;
	},
	async teardown({ device }) {
		await device.shell("cmd statusbar collapse");
		await notificationsOff(device).catch(() => {});
	},
	steps: [
		["Tap the menu button at the top left of the screen", ({ device }) => device.openDrawer()],
		['Tap "Turn on notifications" near the bottom of the drawer', ({ device }) => device.tap({ selector: "#nav [data-push] [data-push-label]", text: "Turn on notifications" })],
		[
			'Tap "Allow" in the Chrome dialog asking whether localhost:3000 may send notifications',
			async ({ device }) => {
				await device.findNative((n) => n.pkg === "com.android.chrome" && /localhost:3000/.test(n.text) && /notification/i.test(n.text), { message: "Chrome's notification permission dialog for localhost:3000" });
				await device.tapNative((n) => n.pkg === "com.android.chrome" && n.clickable && /^Allow$/i.test(n.text), { message: 'the "Allow" button' });
			},
		],
		[
			'Verify that a message reading "Notifications are on for this device." appears',
			async ({ device }) => {
				const started = Date.now();
				// Subscribing just after setup cleared Chrome's data waits for Chrome's first push registration.
				await device.until(toast, "Notifications are on for this device.", { timeout: 60_000, message: '"Notifications are on for this device."' }).catch(async (error) => {
					const item = await device.eval(() => document.querySelector("#nav [data-push]")?.dataset.state).catch(() => "unknown");
					const shown = await device.eval(() => document.querySelector("#toast")?.innerText.trim()).catch(() => "");
					fail(`${error.message}; the drawer item is "${item}"${shown ? `, the page shows "${shown}"` : ""}`);
				});
				device.log(`  subscribed in ${Math.round((Date.now() - started) / 100) / 10} s`);
				expect(await device.eval(() => document.querySelector("#nav [data-push]")?.dataset.state === "on"), "the drawer item is not on");
			},
			{ timeout: 75_000 },
		],
		[
			"Press the Home button to go to the Android home screen",
			async ({ device }) => {
				// DevTools keeps an attached page "visible" behind the home screen (see detach): let go of it first.
				await device.detach();
				await device.home();
				await waitFor(async () => /Launcher/.test(await device.shell("dumpsys window | grep -m1 mCurrentFocus 2>/dev/null")), { timeout: 5_000, message: "the home screen" });
			},
		],
		[
			'On the computer, deliver a new message to support@example.com from "Journey Sender 1" with a new subject',
			async ({ device, state }) => {
				// The page closes its realtime socket once it is hidden, and the sockets setup's page loads left
				// behind close through the runner's relay a little later: give both a moment to reach the server.
				await sleep(5_000);
				// deliverMail numbers each message: it is "Journey Sender 1" with subject "<prefix> 1".
				await device.deliverMail(1, state.first);
				state.first = `${state.first} 1`;
				state.deliveredAt = Date.now();
			},
		],
		[
			"Swipe down from the top of the screen to open the notification shade",
			async ({ device }) => {
				// Stands in for the swipe, as openQuickSettings does: `input swipe` from the status bar is not reliably the shade gesture.
				await device.shell("cmd statusbar expand-notifications");
				await waitFor(() => device.shadeOpen(), { timeout: 5_000, message: "the notification shade to open" });
			},
		],
		[
			'Verify that within 90 seconds a notification from "Journey Sender 1" showing that subject appears in the shade',
			async ({ device, state }) => {
				const node = await device.findNative((n) => shade(n) && n.text === state.first, { timeout: 90_000, message: `a notification showing "${state.first}"` }).catch(async (error) => {
					const postedNow = await posted(device, state.first);
					fail(`${error.message}${postedNow ? " (it is posted, but not shown in the shade)" : "; none was posted (the server sends none while a v2 page holds its realtime socket open, #45, and the push service can be slow)"}`);
				});
				state.latency = Date.now() - state.deliveredAt;
				device.log(`  the notification arrived ${Math.round(state.latency / 100) / 10} s after delivery`);
				const nodes = await device.nativeNodes();
				expect(nodes.some((n) => shade(n) && n.text === SENDER), `the notification does not name "${SENDER}"`);
				state.notification = node;
			},
			// The push service takes from a few seconds to over a minute on a busy emulator host.
			{ timeout: 100_000 },
		],
		[
			"Tap that notification",
			async ({ device, state }) => {
				const node = await device.tapNative((n) => shade(n) && n.text === state.first, { message: `the notification showing "${state.first}"` });
				state.notification = node;
				await waitFor(async () => /ChromeTabbedActivity/.test(await device.shell("dumpsys window | grep -m1 mCurrentFocus 2>/dev/null")), { timeout: 15_000, message: "Chrome to come to the front" });
			},
		],
		[
			"Verify that Chrome comes to the front showing Mailflare's conversation view of that message, with its subject as the heading",
			async ({ device, state }) => {
				await device.page({ timeout: 30_000 });
				await device.until((subject) => /^\/v2\/inbox\/[^/]+$/.test(location.pathname) && window.__j.byText("h1.thread-subject", subject), state.first, { timeout: 20_000, message: `the conversation "${state.first}"` }).catch(async (error) => {
					// What the page went through since the tap (read only; nothing could watch before it, see detach).
					const seen = await device.eval(() => {
						const nav = performance.getEntriesByType("navigation")[0];
						const at = (ms) => Math.round(performance.timeOrigin + ms - Date.now());
						return {
							href: location.href,
							history: [history.length, JSON.stringify(history.state)],
							discarded: document.wasDiscarded ?? null,
							document: nav ? `${nav.type}, loaded ${-at(0)} ms ago` : null,
							requests: performance.getEntriesByType("resource").filter((e) => /\/v2\/(?!assets)|\/api\/realtime/.test(e.name)).slice(-8).map((e) => `${at(e.startTime)} ms ${new URL(e.name).pathname}${new URL(e.name).search} (${e.initiatorType})`),
						};
					}).catch((e) => `unreadable: ${e.message}`);
					fail(`${error.message}; the page: ${JSON.stringify(seen)}`);
				});
				// SystemUI reports the shade's state a moment late.
				await waitFor(async () => !(await device.shadeOpen()), { timeout: 5_000, message: "the notification shade to close" });
			},
		],
		[
			"Press the Back button to return to the inbox",
			async ({ device }) => {
				await device.back();
				await device.until(() => location.pathname === "/v2/inbox" && !!document.querySelector("li[data-row]"), null, { timeout: 15_000, message: "the inbox" });
				await device.settle();
				// Marks this document: a reload would lose it.
				await device.eval(() => (window.__jSameDocument = true));
			},
		],
		[
			"On the computer, deliver another new message to support@example.com with a second new subject",
			async ({ device, state }) => {
				await device.deliverMail(1, state.second);
				state.second = `${state.second} 1`;
			},
		],
		[
			"Verify that within 30 seconds the second message appears in the inbox list without the page reloading",
			async ({ device, state }) => {
				await device.until((subject) => [...document.querySelectorAll("li[data-row] .row-subject")].some((el) => window.__j.text(el) === subject), state.second, { timeout: 30_000, message: `"${state.second}" in the inbox list` });
				expect(await device.eval(() => window.__jSameDocument === true), "the page reloaded");
			},
		],
		[
			"Wait as long as the first notification took to arrive (at least 10 seconds), then verify that no notification showing the second subject has been posted",
			async ({ device, state }) => {
				const bound = Math.min(Math.max(state.latency * 1.5, 10_000), 50_000);
				const deadline = Date.now() + bound;
				while (Date.now() < deadline) {
					if (await posted(device, state.second)) fail(`a notification showing "${state.second}" was posted while the inbox was on screen`);
					await sleep(1_000);
				}
				device.log(`  no notification in ${Math.round(bound / 1000)} s`);
			},
		],
	],
};

export default journey;
