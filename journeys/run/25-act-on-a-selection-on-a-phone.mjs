import { APP, expect, waitFor } from "./harness.mjs";

const FOLDER = "Journey receipts";
const MORE = "#main .toolbar [data-menu=more]";
const SNOOZE = "#main .toolbar [data-menu=snooze]";
const MOVE = "#main .toolbar [data-menu=move]";
const REFUSED = /isn't available here/;

// A bottom sheet: fixed to the bottom edge of the screen and on screen.
const SHEET = (selector) => {
	const el = [...document.querySelectorAll(selector)].find(window.__j.visible);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return getComputedStyle(el).position === "fixed" && r.bottom >= innerHeight - 24 && r.top > innerHeight * 0.15 ? window.__j.text(el) : null;
};

/**
 * What is wrong with the list toolbar's controls: a toolbar wider than the screen, or a control (by
 * its label) off screen, under 44 px, or covered at its centre. Returns the labels too.
 */
const TOOLBAR_PROBLEMS = () => {
	const toolbar = document.querySelector("#main .toolbar");
	const problems = [];
	if (toolbar.scrollWidth > toolbar.clientWidth) problems.push(`the toolbar is ${toolbar.scrollWidth} px wide on a ${toolbar.clientWidth} px screen`);
	const controls = [...toolbar.querySelectorAll(".tb-select, .tb-selected > .icon-button, .tb-selected > details > summary")].filter((el) => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	});
	const labels = [];
	for (const el of controls) {
		const r = el.getBoundingClientRect();
		const label = el.getAttribute("aria-label") || el.querySelector("[aria-label]")?.getAttribute("aria-label") || el.className;
		labels.push(label);
		if (r.left < 0 || r.right > innerWidth + 0.5) {
			problems.push(`"${label}" is off screen (${Math.round(r.left)}–${Math.round(r.right)} of ${innerWidth})`);
			continue;
		}
		if (r.width < 43.5 || r.height < 43.5) problems.push(`"${label}" is ${Math.round(r.width)}×${Math.round(r.height)} px`);
		const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		if (!(hit === el || el.contains(hit))) problems.push(`"${label}" is covered by ${window.__j.describe(hit)}`);
	}
	return { problems, labels };
};

// Sheet items, checked at their left, centre and right: the compose button floats over the bottom right.
const SHEET_ITEMS_COVERED = (selector) => {
	const covered = [];
	for (const el of document.querySelectorAll(`${selector} .menu-item`)) {
		const r = el.getBoundingClientRect();
		for (const fx of [0.1, 0.5, 0.9]) {
			const hit = document.elementFromPoint(r.x + r.width * fx, r.y + r.height / 2);
			if (!(hit === el || el.contains(hit))) {
				covered.push(`"${window.__j.text(el)}" by ${window.__j.describe(hit)}`);
				break;
			}
		}
	}
	return covered;
};

const toast = () => {
	const el = document.querySelector("#toast .toast span");
	return el && window.__j.shown(el) ? window.__j.text(el) : "";
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
const selectedIds = () => [...document.querySelectorAll("[data-row-check]:checked")].map((input) => input.value);

/** Taps the avatar of the conversation at `index` in the list and waits for it to be selected; returns its id and subject. */
async function select(device, index) {
	const row = await device.eval((index) => {
		const el = document.querySelectorAll("li[data-row]")[index];
		return { id: el.dataset.id, subject: window.__j.text(el.querySelector(".row-subject")) };
	}, index);
	await device.tap(`li[data-row][data-id="${row.id}"] .row-select .avatar`, { effect: (id) => document.querySelector(`li[data-row][data-id="${id}"]`)?.classList.contains("is-selected"), arg: row.id });
	return row;
}

/** Opens a toolbar menu as a bottom sheet. */
const openMenu = (device, menu) => device.tap(`${menu} > summary`, { effect: (sel) => document.querySelector(sel)?.open, arg: menu, effectTimeout: 4_000 });

async function seeSheet(device, menu, items) {
	const text = await device.until(SHEET, `${menu} .menu-panel`, { message: "a panel at the bottom of the screen" });
	for (const item of items) expect(text.includes(item), `the panel does not list "${item}" (it shows: ${text.slice(0, 160)})`);
}

/** The inbox list after an action, or the refusal that stopped it. */
async function backOnInbox(device) {
	await device.until(() => location.pathname === "/v2/inbox" || /isn't available here/.test(window.__j.text(document.querySelector("#toast") ?? document.body)), null, { timeout: 15_000, message: "the inbox list or a refusal" });
	const text = await device.eval(toast);
	expect(!REFUSED.test(text), `the app answered "${text}"`);
	await device.until(() => location.pathname === "/v2/inbox" && !!document.querySelector(".page[data-page=list]"), null, { timeout: 15_000, message: "the inbox list" });
	await device.settle();
}

async function listedIn(device, path, label, rows) {
	await device.until((path) => location.pathname === path && !!document.querySelector(".page[data-page=list]"), path, { message: `the ${label} list` });
	for (const row of rows) await device.until(shownInList, row.id, { message: `"${row.subject}" in ${label}` });
}

const journey = {
	async setup({ device, state }) {
		await device.startSignedIn();
		// The folder to move into, made once and reused by later runs.
		state.folder = await device.eval(async (name) => {
			const { mailboxes } = await (await fetch("/api/mailboxes")).json();
			const mailbox = mailboxes.find((m) => m.localPart === "support") ?? mailboxes[0];
			const { folders } = await (await fetch(`/api/folders?mailboxId=${mailbox.id}`)).json();
			const found = folders.find((folder) => folder.name === name);
			if (found) return found.id;
			const res = await fetch("/api/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mailboxId: mailbox.id, name }) });
			const made = await res.json();
			return made.folder?.id ?? made.id ?? `none (${res.status})`;
		}, FOLDER);
		expect(/^fld_/.test(state.folder), `the "${FOLDER}" folder could not be made: ${state.folder}`);
		// Three conversations of its own at the top of the inbox, none snoozed.
		const prefix = `Selection ${Date.now().toString(36)}`;
		await device.deliverMail(3, prefix);
		await waitFor(async () => {
			await device.goto(`${APP}/v2/inbox`);
			return device.eval((prefix) => {
				const subjects = [...document.querySelectorAll("li[data-row] .row-subject")].slice(0, 3).map((el) => el.textContent.trim());
				return subjects.length === 3 && subjects.every((subject) => subject.startsWith(prefix));
			}, prefix);
		}, { timeout: 30_000, interval: 1_000, message: `the three "${prefix}" conversations at the top of the inbox` });
		await device.settle();
	},
	steps: [
		[
			"Tap the round picture with the sender's initials at the left of the first conversation in the inbox list",
			async ({ device, state }) => (state.first = await select(device, 0)),
		],
		[
			"Tap the round picture with the sender's initials at the left of the second conversation in the inbox list",
			async ({ device, state }) => (state.second = await select(device, 1)),
		],
		[
			'Verify that both conversations show a check mark instead of their picture, the toolbar at the top reads "2 selected", and every button in the toolbar (select all, Archive, Delete, Snooze, Move to and More actions) is entirely on screen, at least 44 pixels wide and tall, and not covered by anything',
			async ({ device, state }) => {
				for (const row of [state.first, state.second]) {
					await device.until((id) => window.__j.shown(document.querySelector(`li[data-row][data-id="${id}"] .row-select .check-mark`)), row.id, { message: `a check mark on "${row.subject}"` });
				}
				await device.see("2 selected", { selector: "#main .toolbar [data-selected-count]" });
				const { problems, labels } = await device.eval(TOOLBAR_PROBLEMS);
				expect(problems.length === 0, problems.join("; "));
				for (const label of ["Select all conversations", "Archive", "Delete", "Snooze", "Move to", "More actions"]) {
					expect(labels.includes(label), `the toolbar has no "${label}" button (it has: ${labels.join(", ")})`);
				}
			},
		],
		['Tap the "More actions" button (three dots) at the right of the toolbar', ({ device }) => openMenu(device, MORE)],
		[
			'Verify that a panel slides up from the bottom of the screen listing "Report spam", "Mark as read" and "Mark as unread", with nothing covering them',
			async ({ device }) => {
				await seeSheet(device, MORE, ["Report spam", "Mark as read", "Mark as unread"]);
				const covered = await device.eval(SHEET_ITEMS_COVERED, MORE);
				expect(covered.length === 0, `covered: ${covered.join("; ")}`);
			},
		],
		["Press the Android Back button once", ({ device }) => device.back()],
		[
			"Verify that the panel is gone, the inbox list is still shown and both conversations are still selected",
			async ({ device, state }) => {
				await device.until((sel) => !document.querySelector(`${sel}[open]`), MORE, { timeout: 5_000, message: "the More actions panel to close" });
				const now = await device.eval(() => location.pathname);
				expect(now === "/v2/inbox", `the page is ${now}, not the inbox`);
				const ids = await device.eval(selectedIds);
				expect(ids.length === 2 && ids.includes(state.first.id) && ids.includes(state.second.id), `selected: ${ids.length} conversation(s)`);
			},
		],
		['Tap the "Snooze" button (clock) in the toolbar', ({ device }) => openMenu(device, SNOOZE)],
		[
			'Verify that a panel slides up from the bottom of the screen listing "Later today", "Tomorrow", "This weekend" and "Next week"',
			({ device }) => seeSheet(device, SNOOZE, ["Later today", "Tomorrow", "This weekend", "Next week"]),
		],
		['Tap "Next week" in that panel', ({ device }) => device.tap({ selector: `${SNOOZE} .menu-item`, text: /^Next week/ })],
		[
			'Verify that the inbox list is shown with a message starting "Snoozed until", and that neither selected conversation is in the list',
			async ({ device, state }) => {
				await backOnInbox(device);
				await device.see(/^Snoozed until /, { selector: "#toast .toast span" });
				for (const row of [state.first, state.second]) expect(!(await device.eval(listed, row.id)), `"${row.subject}" is still in the inbox list`);
			},
		],
		['Tap the menu button at the top left of the screen and tap "Snoozed" in the drawer', ({ device }) => device.drawerTo("Snoozed")],
		["Verify that both snoozed conversations are listed in Snoozed", ({ device, state }) => listedIn(device, "/v2/snoozed", "Snoozed", [state.first, state.second])],
		['Tap the menu button at the top left of the screen and tap "Inbox" in the drawer', ({ device }) => device.drawerTo("Inbox")],
		[
			"Tap the round picture with the sender's initials at the left of the first conversation in the inbox list",
			async ({ device, state }) => {
				await device.until(() => location.pathname === "/v2/inbox" && !!document.querySelector("li[data-row]"), null, { message: "the inbox list" });
				state.moved = await select(device, 0);
			},
		],
		[
			'Verify that the toolbar at the top reads "1 selected" and its "Move to" button (folder with an arrow) is on screen and not covered',
			async ({ device }) => {
				await device.see("1 selected", { selector: "#main .toolbar [data-selected-count]" });
				const { problems, labels } = await device.eval(TOOLBAR_PROBLEMS);
				expect(labels.includes("Move to"), `the toolbar has no "Move to" button (it has: ${labels.join(", ")})`);
				expect(problems.length === 0, problems.join("; "));
			},
		],
		['Tap the "Move to" button in the toolbar', ({ device }) => openMenu(device, MOVE)],
		[
			'Verify that a panel slides up from the bottom of the screen listing "Inbox", "Archive", "Spam", "Trash" and "Journey receipts"',
			async ({ device }) => {
				await seeSheet(device, MOVE, ["Inbox", "Archive", "Spam", "Trash", FOLDER]);
				const covered = await device.eval(SHEET_ITEMS_COVERED, MOVE);
				expect(covered.length === 0, `covered: ${covered.join("; ")}`);
			},
		],
		['Tap "Journey receipts" in that panel', ({ device }) => device.tap({ selector: `${MOVE} .menu-item`, text: FOLDER })],
		[
			'Verify that the inbox list is shown with a message ending "moved to Journey receipts.", and that the conversation is no longer in the list',
			async ({ device, state }) => {
				await backOnInbox(device);
				await device.see(/moved to Journey receipts\.$/, { selector: "#toast .toast span" });
				expect(!(await device.eval(listed, state.moved.id)), `"${state.moved.subject}" is still in the inbox list`);
			},
		],
		['Tap the menu button at the top left of the screen and tap "Journey receipts" in the drawer', ({ device }) => device.drawerTo(FOLDER)],
		["Verify that the moved conversation is listed in Journey receipts", ({ device, state }) => listedIn(device, `/v2/folder/${state.folder}`, FOLDER, [state.moved])],
	],
};

export default journey;
