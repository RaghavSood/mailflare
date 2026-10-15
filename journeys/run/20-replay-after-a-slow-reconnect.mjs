import { APP, expect, retryUnlessDone, sleep, waitFor } from "./harness.mjs";

const SUBJECT = "Slow reconnect journey";

const banner = () => {
	const el = document.querySelector("[data-offline-banner]");
	return el && window.__j.shown(el) ? window.__j.text(el) : null;
};

const listed = (id) => [...document.querySelectorAll("li[data-row]")].some((row) => row.dataset.id === id && window.__j.visible(row));

const journey = {
	async setup({ device }) {
		await device.startSignedIn({ rows: 2 });
		// Newer than anything archived earlier, so it heads the Archive list at the end (Verify only looks at what is on screen).
		await device.deliverMail(1, SUBJECT);
		await waitFor(async () => {
			const page = await device.goto(`${APP}/v2/inbox`);
			return page.evaluate((subject) => document.querySelector("li[data-row] .row-subject")?.textContent.trim().startsWith(subject), SUBJECT);
		}, { timeout: 30_000, interval: 1_000, message: `"${SUBJECT}" at the top of the inbox` });
		await device.ensureServiceWorker();
	},
	steps: [
		[
			'Swipe down from the very top edge of the screen twice to open Quick Settings, and tap "Airplane mode" to turn it on',
			async ({ device }) => {
				await device.openQuickSettings();
				await device.setAirplaneMode(true);
			},
		],
		[
			"Close Quick Settings",
			async ({ device }) => {
				await device.closeQuickSettings();
				await device.until(() => !navigator.onLine, null, { message: "the page to see the device offline" });
			},
		],
		[
			"Swipe the first conversation row from the left edge of the screen towards the right edge",
			async ({ device, state }) => {
				state.row = await device.eval(() => {
					const row = [...document.querySelectorAll("li[data-row]")].find(window.__j.visible);
					return { id: row.dataset.id, subject: window.__j.text(row.querySelector(".row-subject")) };
				});
				// Swiped once more only if the row is still there: a second swipe at a row already gone would queue the next one.
				await retryUnlessDone(() => device.swipe("li[data-row]", { from: [0.03, 0.5], to: [0.97, 0.5], ms: 350, screenEdge: true }), async () => !(await device.eval(listed, state.row.id)), { timeout: 4_000, message: "the swiped row to leave the list", log: device.log });
			},
		],
		[
			'Verify that the swiped row is no longer in the list and the banner at the top reads "Offline" followed by "1 change waiting"',
			async ({ device, state }) => {
				expect(!(await device.eval(listed, state.row.id)), `"${state.row.subject}" is still in the list`);
				await device.until(() => {
					const el = document.querySelector("[data-offline-banner]");
					return el && window.__j.shown(el) && /^Offline\b.*1 change waiting/.test(window.__j.text(el));
				}, null, { message: 'the banner to read "Offline … 1 change waiting"' }).catch(async (error) => {
					throw new Error(`${error.message}; it reads "${await device.eval(banner)}"`);
				});
			},
		],
		[
			'Keep the Mailflare server unreachable (on an emulator, leave the `adb reverse` tunnel to the server cut), swipe down from the very top edge of the screen twice to open Quick Settings, and tap "Airplane mode" to turn it off',
			async ({ device }) => {
				await device.openQuickSettings();
				// The runner's relay keeps refusing connections: the device comes online before the server can be reached.
				await device.setAirplaneMode(false, { serverReachable: false });
			},
		],
		[
			"Close Quick Settings and wait 5 seconds after the device is back online",
			async ({ device }) => {
				await device.closeQuickSettings();
				await device.until(() => navigator.onLine, null, { timeout: 30_000, message: "the page to see the device online" });
				// Coming online replays the outbox at once (the page, and Background Sync): those tries fail here.
				await sleep(5_000);
				const reached = await device.eval(() => fetch(`/login?offline-check=${Date.now()}`, { cache: "no-store" }).then(() => true, () => false));
				expect(!reached, "the page can reach the server, which should still be cut off");
			},
		],
		[
			'Verify that the banner at the top reads "Syncing" followed by "1 change waiting"',
			async ({ device }) => {
				const text = await device.eval(banner);
				expect(/^Syncing\b.*1 change waiting/.test(text ?? ""), `the banner reads "${text}"`);
			},
		],
		[
			"Make the Mailflare server reachable again and wait 30 seconds",
			async ({ device }) => {
				device.setRelayOffline(false);
				// Up to 30 s (the retries back off, and a busy device can come online well before the step); stops early once the banner has gone.
				await waitFor(async () => !(await device.eval(banner).catch(() => "unknown")), { timeout: 30_000 }).catch(() => {});
			},
		],
		[
			"Verify that the banner is gone and the swiped conversation is still not in the inbox list",
			async ({ device, state }) => {
				const text = await device.eval(banner);
				expect(!text, `the banner still reads "${text}"`);
				const now = await device.eval(() => location.pathname);
				expect(now === "/v2/inbox", `the page is ${now}, not the inbox`);
				expect(!(await device.eval(listed, state.row.id)), `"${state.row.subject}" is back in the inbox list`);
			},
		],
		['Tap the menu button at the top left of the screen and tap "Archive" in the drawer', ({ device }) => device.drawerTo("Archive")],
		[
			"Verify that the conversation swiped while offline is listed in Archive",
			async ({ device, state }) => {
				await device.until(() => location.pathname === "/v2/archive" && window.__j.byText(".tb-title", "Archive"), null, { message: "the Archive list" });
				await device.until(listed, state.row.id, { message: `"${state.row.subject}" in Archive` });
			},
		],
	],
};

export default journey;
