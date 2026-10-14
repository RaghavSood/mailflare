import { APP, expect, waitFor } from "./harness.mjs";

// A bottom sheet: fixed to the bottom edge of the screen and on screen.
const SHEET = (selector) => {
	const el = [...document.querySelectorAll(selector)].find(window.__j.visible);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return getComputedStyle(el).position === "fixed" && r.bottom >= innerHeight - 24 && r.top > innerHeight * 0.15 ? window.__j.text(el) : null;
};

const MOVE = "#main .toolbar [data-menu=move]";
const SNOOZE = "#main .toolbar [data-menu=snooze]";
const REFUSED = /isn't available here/;

const toast = () => {
	const el = document.querySelector("#toast");
	return el ? window.__j.text(el) : "";
};
const banner = () => {
	const el = document.querySelector("[data-offline-banner]");
	return el && window.__j.shown(el) ? window.__j.text(el) : null;
};
// Anywhere in the list, on screen or not.
const listed = (id) => [...document.querySelectorAll("li[data-row]")].some((row) => row.dataset.id === id);
// In the list and on screen, scrolled to if need be.
const shownInList = (id) => {
	const row = [...document.querySelectorAll("li[data-row]")].find((el) => el.dataset.id === id);
	if (!row) return false;
	if (!window.__j.visible(row)) row.scrollIntoView({ block: "center" });
	return window.__j.visible(row);
};

/** Taps the first row and waits for its conversation; returns its id and subject. */
async function openFirst(device) {
	const row = await device.eval(() => {
		const el = [...document.querySelectorAll("li[data-row]")].find(window.__j.visible);
		return { id: el.dataset.id, subject: window.__j.text(el.querySelector(".row-subject")) };
	});
	await device.tap(`li[data-row][data-id="${row.id}"] .row-subject`, { effect: (id) => location.pathname.endsWith(`/${id}`), arg: row.id, effectTimeout: 8_000 });
	await device.until((subject) => window.__j.byText("h1.thread-subject", subject), row.subject, { timeout: 15_000, message: `the "${row.subject}" heading` });
	return row;
}

/** Opens a toolbar menu as a bottom sheet. */
const openMenu = (device, menu) => device.tap(`${menu} > summary`, { effect: (sel) => document.querySelector(sel)?.open, arg: menu, effectTimeout: 4_000 });

async function seeSheet(device, menu, items) {
	const text = await device.until(SHEET, `${menu} .menu-panel`, { message: "a panel at the bottom of the screen" });
	for (const item of items) expect(text.includes(item), `the panel does not list "${item}" (it shows: ${text.slice(0, 120)})`);
}

/** The inbox list, after an action that left the conversation. */
async function backOnInbox(device) {
	await device.until(() => location.pathname === "/v2/inbox" && !!document.querySelector(".page[data-page=list]"), null, { timeout: 15_000, message: "the inbox list" });
	await device.settle();
}

async function listedIn(device, view, label, row) {
	await device.until((view) => location.pathname === `/v2/${view}` && !!document.querySelector(".page[data-page=list]"), view, { message: `the ${label} list` });
	await device.until(shownInList, row.id, { message: `"${row.subject}" in ${label}` });
}

const journey = {
	async setup({ device }) {
		await device.startSignedIn();
		// Three conversations of its own at the top of the inbox, none starred or snoozed.
		const prefix = `Toolbar ${Date.now().toString(36)}`;
		await device.deliverMail(3, prefix);
		await waitFor(async () => {
			await device.goto(`${APP}/v2/inbox`);
			return device.eval((prefix) => {
				const subjects = [...document.querySelectorAll("li[data-row] .row-subject")].slice(0, 3).map((el) => el.textContent.trim());
				return subjects.length === 3 && subjects.every((subject) => subject.startsWith(prefix));
			}, prefix);
		}, { timeout: 30_000, interval: 1_000, message: `the three "${prefix}" conversations at the top of the inbox` });
		await device.ensureServiceWorker();
	},
	steps: [
		["Tap the first conversation in the inbox list", async ({ device, state }) => (state.archived = await openFirst(device))],
		[
			"Verify that the conversation opens with its subject shown as a heading",
			({ device, state }) => device.see(state.archived.subject, { selector: "h1.thread-subject" }),
		],
		['Tap the "Move to" button (folder with an arrow) in the toolbar at the top of the conversation', ({ device }) => openMenu(device, MOVE)],
		[
			'Verify that a panel slides up from the bottom of the screen listing "Inbox", "Archive", "Spam" and "Trash"',
			({ device }) => seeSheet(device, MOVE, ["Inbox", "Archive", "Spam", "Trash"]),
		],
		['Tap "Archive" in that panel', ({ device }) => device.tap({ selector: `${MOVE} .menu-item`, text: "Archive" })],
		[
			'Verify that the inbox list is shown with a message reading "Conversation archived." and an "Undo" button, that the archived conversation is no longer in the list, and that no message reads "That action isn\'t available here."',
			async ({ device, state }) => {
				await device.until(() => location.pathname === "/v2/inbox" || /isn't available here/.test(window.__j.text(document.querySelector("#toast") ?? document.body)), null, { timeout: 15_000, message: "the inbox list or a refusal" });
				const text = await device.eval(toast);
				expect(!REFUSED.test(text), `the app answered "${text}"`);
				await backOnInbox(device);
				await device.see("Conversation archived.", { selector: "#toast .toast span" });
				await device.see("Undo", { selector: "#toast [data-undo]" });
				expect(!(await device.eval(listed, state.archived.id)), `"${state.archived.subject}" is still in the inbox list`);
			},
		],
		['Tap the menu button at the top left of the screen and tap "Archive" in the drawer', ({ device }) => device.drawerTo("Archive")],
		["Verify that the archived conversation is listed in Archive", ({ device, state }) => listedIn(device, "archive", "Archive", state.archived)],
		['Tap the menu button at the top left of the screen and tap "Inbox" in the drawer', ({ device }) => device.drawerTo("Inbox")],
		["Tap the first conversation in the inbox list", async ({ device, state }) => (state.snoozed = await openFirst(device))],
		[
			"Tap the star button at the right end of the toolbar",
			async ({ device, state }) => {
				state.wasStarred = await device.eval(() => document.querySelector("#main .toolbar .star-button").classList.contains("is-starred"));
				await device.tap("#main .toolbar .star-button");
			},
		],
		[
			'Verify that the star in the toolbar is filled in, the same conversation is still shown, and no message reads "That action isn\'t available here."',
			async ({ device, state }) => {
				expect(!state.wasStarred, "the conversation was already starred");
				await device.until(() => document.querySelector("#main .toolbar .star-button.is-starred[aria-pressed=true]") || /isn't available here/.test(window.__j.text(document.querySelector("#toast") ?? document.body)), null, { timeout: 15_000, message: "a filled star" });
				const text = await device.eval(toast);
				expect(!REFUSED.test(text), `the app answered "${text}"`);
				await device.settle();
				expect(await device.eval(() => !!document.querySelector("#main .toolbar .star-button.is-starred")), "the star is not filled in");
				await device.see(state.snoozed.subject, { selector: "h1.thread-subject" });
			},
		],
		['Tap the "Snooze" button (clock) in the toolbar', ({ device }) => openMenu(device, SNOOZE)],
		[
			'Verify that a panel slides up from the bottom of the screen listing "Later today", "Tomorrow", "This weekend" and "Next week"',
			({ device }) => seeSheet(device, SNOOZE, ["Later today", "Tomorrow", "This weekend", "Next week"]),
		],
		['Tap "Next week" in that panel', ({ device }) => device.tap({ selector: `${SNOOZE} .menu-item`, text: /^Next week/ })],
		[
			'Verify that the inbox list is shown with a message starting "Snoozed until", and that the snoozed conversation is no longer in the list',
			async ({ device, state }) => {
				await device.until(() => location.pathname === "/v2/inbox" || /isn't available here/.test(window.__j.text(document.querySelector("#toast") ?? document.body)), null, { timeout: 15_000, message: "the inbox list or a refusal" });
				const text = await device.eval(toast);
				expect(!REFUSED.test(text), `the app answered "${text}"`);
				await backOnInbox(device);
				await device.see(/^Snoozed until /, { selector: "#toast .toast span" });
				expect(!(await device.eval(listed, state.snoozed.id)), `"${state.snoozed.subject}" is still in the inbox list`);
			},
		],
		['Tap the menu button at the top left of the screen and tap "Snoozed" in the drawer', ({ device }) => device.drawerTo("Snoozed")],
		["Verify that the snoozed conversation is listed in Snoozed", ({ device, state }) => listedIn(device, "snoozed", "Snoozed", state.snoozed)],
		['Tap the menu button at the top left of the screen and tap "Starred" in the drawer', ({ device }) => device.drawerTo("Starred")],
		["Verify that the snoozed conversation is listed in Starred too", ({ device, state }) => listedIn(device, "starred", "Starred", state.snoozed)],
		['Tap the menu button at the top left of the screen and tap "Inbox" in the drawer', ({ device }) => device.drawerTo("Inbox")],
		["Tap the first conversation in the inbox list", async ({ device, state }) => (state.offline = await openFirst(device))],
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
			'Tap the "Move to" button in the toolbar and tap "Archive" in the panel that slides up',
			async ({ device }) => {
				await openMenu(device, MOVE);
				await device.until(SHEET, `${MOVE} .menu-panel`, { message: "the Move to panel" });
				await device.tap({ selector: `${MOVE} .menu-item`, text: "Archive" });
			},
		],
		[
			'Verify that the inbox list is shown, the banner at the top reads "Offline" followed by "1 change waiting", and the conversation is no longer in the list',
			async ({ device, state }) => {
				await device.until(() => location.pathname === "/v2/inbox" && document.readyState === "complete" && !!document.querySelector(".page[data-page=list]"), null, { timeout: 15_000, message: "the inbox list" });
				await device.until(() => {
					const el = document.querySelector("[data-offline-banner]");
					return el && window.__j.shown(el) && /^Offline\b.*1 change waiting/.test(window.__j.text(el));
				}, null, { message: 'the banner to read "Offline … 1 change waiting"' }).catch(async (error) => {
					throw new Error(`${error.message}; it reads "${await device.eval(banner)}"`);
				});
				expect(!(await device.eval(listed, state.offline.id)), `"${state.offline.subject}" is still in the inbox list`);
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
			"Verify that the banner is gone and the conversation archived offline is still not in the inbox list",
			async ({ device, state }) => {
				const text = await device.eval(banner);
				expect(!text, `the banner still reads "${text}"`);
				const now = await device.eval(() => location.pathname);
				expect(now === "/v2/inbox", `the page is ${now}, not the inbox`);
				expect(!(await device.eval(listed, state.offline.id)), `"${state.offline.subject}" is back in the inbox list`);
			},
		],
		['Tap the menu button at the top left of the screen and tap "Archive" in the drawer', ({ device }) => device.drawerTo("Archive")],
		["Verify that the conversation archived offline is listed in Archive", ({ device, state }) => listedIn(device, "archive", "Archive", state.offline)],
	],
};

export default journey;
