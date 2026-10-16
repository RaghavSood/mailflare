import { expect, fail } from "./harness.mjs";

// A bottom sheet: fixed to the bottom edge of the screen and on screen.
const SHEET = (selector) => {
	const el = [...document.querySelectorAll(selector)].find(window.__j.visible);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return getComputedStyle(el).position === "fixed" && r.bottom >= innerHeight - 24 && r.top > innerHeight * 0.15 ? window.__j.text(el) : null;
};

const threadState = () => {
	const subject = document.querySelector("h1.thread-subject");
	return { path: location.pathname, subject: subject && window.__j.shown(subject) ? window.__j.text(subject) : null };
};

const journey = {
	setup: ({ device }) => device.startSignedIn(),
	steps: [
		[
			"Tap the first conversation in the inbox list",
			async ({ device, state }) => {
				state.subject = await device.eval(() => window.__j.text(document.querySelector("li[data-row] .row-subject")));
				// The first sender named in the row ("me" is the signed-in user), without the message count a
				// conversation of several shows beside it.
				state.from = await device.eval(() => [...document.querySelector("li[data-row]").querySelectorAll(".row-from > span:not(.row-count):not(.draft-label)")].map(window.__j.text).find((name) => name && name !== "me"));
				await device.tap("li[data-row] .row-subject", { effect: () => location.pathname.startsWith("/v2/inbox/"), effectTimeout: 8_000 });
			},
		],
		[
			'Verify that the conversation opens: its subject is shown as a heading, the sender\'s name is shown, and "Reply", "Reply all" and "Forward" buttons are shown below the message',
			async ({ device, state }) => {
				await device.until((subject) => window.__j.byText("h1.thread-subject", subject), state.subject, { timeout: 15_000, message: `the "${state.subject}" heading` });
				await device.see(state.from, { selector: ".msg-name" });
				await device.see(["Reply", "Reply all", "Forward"], { selector: "#reply-slot button, #reply-slot a, .reply-actions *" });
				const below = await device.eval(() => {
					const body = [...document.querySelectorAll(".msg-body")].filter(window.__j.visible).at(-1);
					const reply = window.__j.byText(".reply-actions *", "Reply");
					return body && reply && reply.getBoundingClientRect().top >= body.getBoundingClientRect().top;
				});
				expect(below, "the Reply buttons are not below the message");
			},
		],
		[
			'Tap the small down-arrow next to "to me" under the sender\'s name',
			({ device }) => device.tap(".msg.is-last .msg-recipients [data-details]", { effect: () => [...document.querySelectorAll(".msg-details")].some((el) => !el.hidden && el.textContent.trim()), effectTimeout: 6_000 }),
		],
		[
			'Verify that a panel slides up from the bottom of the screen showing "from:", "to:", "date:" and "subject:" details',
			async ({ device }) => {
				const text = await device.until(SHEET, ".msg-details:not([hidden])", { message: "a details sheet at the bottom of the screen" });
				for (const label of ["from:", "to:", "date:", "subject:"]) expect(text.toLowerCase().includes(label), `the details sheet does not show "${label}" (it shows: ${text.slice(0, 120)})`);
			},
		],
		[
			"Tap the close (X) button at the top right of that panel",
			async ({ device }) => {
				const corner = await device.eval(() => {
					const sheet = document.querySelector(".msg-details:not([hidden])");
					const close = sheet?.querySelector(".sheet-close");
					if (!close) return null;
					const s = sheet.getBoundingClientRect(), c = close.getBoundingClientRect();
					return c.left > s.left + s.width / 2 && c.top < s.top + 80;
				});
				expect(corner, "the details sheet has no close button at its top right");
				await device.tap(".msg-details:not([hidden]) .sheet-close", { effect: () => ![...document.querySelectorAll(".msg-details")].some((el) => !el.hidden) });
			},
		],
		[
			"Verify that the panel is gone and the conversation is still shown",
			async ({ device, state }) => {
				await device.until(() => ![...document.querySelectorAll(".msg-details")].some((el) => !el.hidden && window.__j.visible(el)), null, { message: "the details sheet to close" });
				const now = await device.eval(threadState);
				expect(now.subject === state.subject, `the conversation is no longer shown (${JSON.stringify(now)})`);
			},
		],
		[
			'Tap the small down-arrow next to "to me" again',
			({ device }) => device.tap(".msg.is-last .msg-recipients [data-details]", { effect: () => [...document.querySelectorAll(".msg-details")].some((el) => !el.hidden && el.textContent.trim()), effectTimeout: 6_000 }),
		],
		[
			'Verify that the panel with "from:", "to:", "date:" and "subject:" details is shown at the bottom of the screen again',
			async ({ device }) => {
				const text = await device.until(SHEET, ".msg-details:not([hidden])", { message: "the details sheet at the bottom of the screen" });
				for (const label of ["from:", "to:", "date:", "subject:"]) expect(text.toLowerCase().includes(label), `the details sheet does not show "${label}"`);
			},
		],
		["Press the Android Back button once", ({ device }) => device.back()],
		[
			"Verify that the panel is gone and the same conversation is still shown, with its subject heading visible",
			async ({ device, state }) => {
				await device.until(() => ![...document.querySelectorAll(".msg-details")].some((el) => !el.hidden && window.__j.visible(el)), null, { timeout: 5_000, message: "the details sheet to close" }).catch(async (error) => {
					fail(`${error.message}; page now ${JSON.stringify(await device.eval(threadState).catch(() => null))}`);
				});
				const now = await device.eval(threadState);
				expect(now.subject === state.subject, `Back left the conversation: the page is now ${now.path}${now.subject ? ` ("${now.subject}")` : ""}`);
			},
		],
		[
			"Tap the three-dot button to the right of the message date",
			({ device }) => device.tap('.msg.is-last details[data-menu="message"] > summary', { effect: () => !!document.querySelector('.msg.is-last details[data-menu="message"][open]') }),
		],
		[
			'Verify that a panel slides up from the bottom of the screen listing "Reply", "Reply all", "Forward" and "Mark unread from here"',
			async ({ device }) => {
				await device.until(SHEET, '.msg.is-last details[data-menu="message"][open] .menu-panel', { message: "the message menu as a sheet at the bottom of the screen" });
				await device.see(["Reply", "Reply all", "Forward", "Mark unread from here"], { selector: 'details[data-menu="message"][open] .menu-item' });
			},
		],
		["Press the Android Back button once", ({ device }) => device.back()],
		[
			"Verify that the bottom panel is closed and the same conversation is still shown, with its subject heading visible",
			async ({ device, state }) => {
				await device.until(() => !document.querySelector('details[data-menu="message"][open]'), null, { timeout: 5_000, message: "the message menu sheet to close" }).catch(async (error) => {
					const now = await device.eval(threadState).catch(() => null);
					throw new Error(`${error.message}; page now ${JSON.stringify(now)}`);
				});
				const now = await device.eval(threadState);
				expect(now.subject === state.subject, `Back left the conversation: the page is now ${now.path}${now.subject ? ` ("${now.subject}")` : ""}`);
			},
		],
		["Press the Android Back button once more", ({ device }) => device.back()],
		[
			"Verify that the inbox list is shown",
			({ device }) => device.until(() => location.pathname === "/v2/inbox" && window.__j.byText(".tb-title", "Inbox") && [...document.querySelectorAll("li[data-row]")].some(window.__j.shown), null, { timeout: 10_000, message: "the inbox list after Back" }),
		],
	],
};

export default journey;
