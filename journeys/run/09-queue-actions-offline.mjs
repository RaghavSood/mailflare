import { expect, waitFor } from "./harness.mjs";

const banner = () => {
	const el = document.querySelector("[data-offline-banner]");
	return el && window.__j.shown(el) ? window.__j.text(el) : null;
};

const listed = (id) => [...document.querySelectorAll("li[data-row]")].some((row) => row.dataset.id === id && window.__j.visible(row));

const journey = {
	async setup({ device }) {
		await device.startSignedIn({ rows: 2 });
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
			"Swipe the first conversation row from the right edge of the screen towards the left edge",
			async ({ device, state }) => {
				state.row = await device.eval(() => {
					const row = [...document.querySelectorAll("li[data-row]")].find(window.__j.visible);
					return { id: row.dataset.id, subject: window.__j.text(row.querySelector(".row-subject")) };
				});
				for (let attempt = 1; ; attempt++) {
					await device.swipe("li[data-row]", { from: [0.97, 0.5], to: [0.03, 0.5], ms: 350, screenEdge: true });
					const gone = await waitFor(async () => !(await device.eval(listed, state.row.id)), { timeout: 4_000, message: "the swiped row to leave the list" }).catch((error) => (attempt >= 2 ? Promise.reject(error) : false));
					if (gone) break;
					device.log("  the swipe did not take; swiping again");
				}
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
			'Verify that no "Undo" button is shown',
			async ({ device }) => {
				const undo = await device.eval(() => [...document.querySelectorAll("[data-undo], #toast button")].some((el) => window.__j.shown(el) && /Undo/.test(window.__j.text(el))));
				expect(!undo, 'an "Undo" button is shown');
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
			"Close Quick Settings and wait 15 seconds",
			async ({ device }) => {
				await device.closeQuickSettings();
				// Up to 15 s; stops early once the banner has gone.
				await waitFor(async () => !(await device.eval(banner).catch(() => "unknown")), { timeout: 15_000 }).catch(() => {});
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
		['Tap the menu button at the top left of the screen and tap "Trash" in the drawer', ({ device }) => device.drawerTo("Trash")],
		[
			"Verify that the conversation swiped while offline is listed in Trash",
			async ({ device, state }) => {
				await device.until(() => location.pathname === "/v2/trash" && window.__j.byText(".tb-title", "Trash"), null, { message: "the Trash list" });
				await device.until(listed, state.row.id, { message: `"${state.row.subject}" in Trash` });
			},
		],
	],
};

export default journey;
