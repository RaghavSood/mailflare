import { APP, expect, sleep, waitFor } from "./harness.mjs";

const REFUSAL = "Nothing to change.";
const ARCHIVE = "#main .toolbar .tb-selected button[value=archive]";

// Anywhere in the list, on screen or not.
const listed = (id) => [...document.querySelectorAll("li[data-row]")].some((row) => row.dataset.id === id);
const firstRow = () => document.querySelector("li[data-row]")?.dataset.id ?? null;
const toast = () => {
	const el = document.querySelector("#toast .toast span");
	return el && window.__j.shown(el) ? window.__j.text(el) : "";
};

const journey = {
	async setup({ device, state }) {
		await device.startSignedIn();
		const prefix = `Refused ${Date.now().toString(36)}`;
		await device.deliverMail(2, prefix);
		await waitFor(async () => {
			await device.goto(`${APP}/v2/inbox`);
			state.rows = await device.eval((prefix) => {
				const rows = [...document.querySelectorAll("li[data-row]")].slice(0, 2);
				const subjects = rows.map((row) => row.querySelector(".row-subject")?.textContent.trim() ?? "");
				return subjects.length === 2 && subjects.every((subject) => subject.startsWith(prefix)) ? rows.map((row, i) => ({ id: row.dataset.id, subject: subjects[i] })) : null;
			}, prefix);
			return state.rows;
		}, { timeout: 30_000, interval: 1_000, message: `the two "${prefix}" conversations at the top of the inbox` });
		await device.settle();
		// Another device moves the first one to Trash; this page is not reloaded, so it still lists it.
		const gone = state.rows[0];
		const status = await device.eval((id) => fetch("/v2/act", { method: "POST", body: new URLSearchParams({ ids: id, action: "trash", view: "inbox", quiet: "1" }) }).then((res) => res.status), gone.id);
		expect(status === 204, `moving "${gone.subject}" to Trash for setup answered ${status}`);
		expect(await device.eval(listed, gone.id), `"${gone.subject}" left the list during setup`);
	},
	steps: [
		[
			"Tap the round picture with the sender's initials at the left of the first conversation in the inbox list",
			async ({ device, state }) => {
				expect((await device.eval(firstRow)) === state.rows[0].id, `"${state.rows[0].subject}" is not the first conversation`);
				await device.tap(`li[data-row][data-id="${state.rows[0].id}"] .row-select .avatar`, { effect: (id) => document.querySelector(`li[data-row][data-id="${id}"]`)?.classList.contains("is-selected"), arg: state.rows[0].id });
			},
		],
		[
			'Verify that a check mark replaces that picture and the toolbar at the top reads "1 selected"',
			async ({ device, state }) => {
				await device.until((id) => window.__j.shown(document.querySelector(`li[data-row][data-id="${id}"] .row-select .check-mark`)), state.rows[0].id, { message: "a check mark on the first conversation" });
				await device.see("1 selected", { selector: "#main .toolbar [data-selected-count]" });
			},
		],
		['Tap the "Archive" button (box) in the toolbar', ({ device }) => device.tap(ARCHIVE)],
		[
			'Verify that the inbox list is shown with a message reading "Nothing to change.", and that the conversation is no longer in the list',
			async ({ device, state }) => {
				// Read once the refusal and the reload it starts are over: on main the message was shown
				// for a few milliseconds before that reload replaced it.
				await device.until(() => !document.querySelector(".htmx-request"), null, { message: "the archive request to finish" });
				await device.settle();
				const now = await device.eval(() => location.pathname);
				expect(now === "/v2/inbox", `the page is ${now}, not the inbox`);
				const text = await device.eval(toast);
				expect(text === REFUSAL, text ? `the message reads "${text}"` : "no message is shown");
				expect(!(await device.eval(listed, state.rows[0].id)), `"${state.rows[0].subject}" is in the inbox list`);
			},
		],
		["Wait 3 seconds", () => sleep(3_000)],
		[
			'Verify that the message "Nothing to change." is still shown and the second new conversation is now at the top of the list',
			async ({ device, state }) => {
				const text = await device.eval(toast);
				expect(text === REFUSAL, text ? `the message reads "${text}"` : "the message is gone");
				expect((await device.eval(firstRow)) === state.rows[1].id, `"${state.rows[1].subject}" is not at the top of the list`);
			},
		],
	],
};

export default journey;
