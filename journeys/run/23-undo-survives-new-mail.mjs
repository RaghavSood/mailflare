import { expect, retryUnlessDone } from "./harness.mjs";

const ARCHIVED = "Conversation archived.";

const firstRow = () => {
	const row = [...document.querySelectorAll("li[data-row]")].find(window.__j.visible);
	return row ? { id: row.dataset.id, subject: window.__j.text(row.querySelector(".row-subject")) } : null;
};

const listed = (id) => [...document.querySelectorAll("li[data-row]")].some((row) => row.dataset.id === id && window.__j.visible(row));

const topSubject = () => window.__j.text(document.querySelector("li[data-row] .row-subject"));

// A toast near the bottom of the screen with this text.
const toast = (text) => {
	const el = [...document.querySelectorAll("#toast .toast")].find((t) => window.__j.visible(t) && window.__j.text(t).includes(text));
	return el && el.getBoundingClientRect().top > innerHeight / 2 ? window.__j.text(el) : null;
};

const undoShown = () => window.__j.shown(document.querySelector("#toast [data-undo]"));

// Set on the document at the start: a full page load (rather than htmx swapping #main) drops it.
const sameDocument = () => window.__jSameDocument === true;

const rowSwipe = { from: [0.03, 0.5], to: [0.97, 0.5], ms: 350, screenEdge: true };

/** Whether a delivered message, by subject prefix, is at the top of the inbox. */
const arrived = (prefix) => window.__j.text(document.querySelector("li[data-row] .row-subject")).startsWith(prefix);

const journey = {
	async setup({ device, state }) {
		await device.startSignedIn({ rows: 2 });
		// Only an open realtime socket reloads the list when mail arrives: prove it is open with a first
		// message, which must appear without the page being loaded again.
		await device.settle();
		await device.eval(() => (window.__jSameDocument = true));
		const warmUp = `Undo warm-up ${Date.now().toString(36)}`;
		await device.deliverMail(1, warmUp);
		await device.until(arrived, warmUp, { timeout: 30_000, message: `"${warmUp}" to appear at the top of the inbox over the realtime connection` });
		expect(await device.eval(sameDocument), "the page was loaded again instead of reloading the list in place");
		await device.settle();
		state.subject = `Undo new mail ${Date.now().toString(36)}`;
	},
	steps: [
		[
			"Swipe the first conversation row from the left edge of the screen towards the right edge",
			async ({ device, state }) => {
				state.archived = await device.eval(firstRow);
				await swipeUntilGone(device, state.archived.id);
			},
		],
		[
			'Verify that a message reading "Conversation archived." with an "Undo" button appears near the bottom of the screen and that row is no longer in the inbox list',
			async ({ device, state }) => {
				await device.until(toast, ARCHIVED, { message: `the "${ARCHIVED}" message near the bottom` });
				await device.see("Undo", { selector: "#toast [data-undo]" });
				expect(!(await device.eval(listed, state.archived.id)), `"${state.archived.subject}" is still in the inbox list`);
			},
		],
		[
			"On the computer, deliver a new message to support@example.com with a new subject",
			async ({ device, state }) => {
				// deliverMail numbers each message: its subject is "<prefix> 1".
				await device.deliverMail(1, state.subject);
			},
		],
		[
			'Verify that within 8 seconds the new message appears at the top of the inbox list without the page reloading, and that the "Conversation archived." message with its "Undo" button is still shown',
			async ({ device, state }) => {
				// The message leaves on its own 9 s after it appeared: the new mail must land before then.
				await device.until(arrived, state.subject, { timeout: 8_000, message: `"${state.subject} 1" to appear at the top of the inbox` }).catch(async (error) => {
					throw new Error(`${error.message}; the top row reads "${await device.eval(topSubject)}"`);
				});
				expect(await device.eval(sameDocument), "the page was loaded again instead of reloading the list in place");
				const text = await device.eval(toast, ARCHIVED);
				expect(text, "the \"Conversation archived.\" message is gone");
				expect(await device.eval(undoShown), "the Undo button is gone");
			},
		],
		['Tap "Undo" in that message', ({ device, state }) => device.tap({ selector: "#toast [data-undo]", text: "Undo" }, { effect: (id) => !document.querySelector("#toast [data-undo]") || [...document.querySelectorAll("li[data-row]")].some((row) => row.dataset.id === id), arg: state.archived.id, effectTimeout: 6_000 })],
		[
			"Verify that the archived conversation is back in the inbox list",
			({ device, state }) =>
				device.until((id) => location.pathname === "/v2/inbox" && [...document.querySelectorAll("li[data-row]")].some((row) => row.dataset.id === id && window.__j.visible(row)), state.archived.id, { timeout: 10_000, message: `"${state.archived.subject}" back in the inbox list` }),
		],
	],
};

/** Swipes the first row; once more if the touch did not take (the row is still there), never at the next row. */
async function swipeUntilGone(device, id) {
	const gone = () => device.eval((rowId) => ![...document.querySelectorAll("li[data-row]")].some((row) => row.dataset.id === rowId && window.__j.visible(row)), id);
	await retryUnlessDone(() => device.swipe("li[data-row]", rowSwipe), gone, { timeout: 4_000, message: "the swiped row to leave the list", log: device.log });
}

export default journey;
