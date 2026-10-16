import { APP, expect, sleep, waitFor } from "./harness.mjs";

const DISCARDED = "Draft discarded.";
const BODY = "Offline reply";
const REPLY = "#reply-slot form[data-composer]";

const banner = () => {
	const el = document.querySelector("[data-offline-banner]");
	return el && window.__j.shown(el) ? window.__j.text(el) : null;
};

// A toast near the bottom of the screen reading exactly this.
const toastNearBottom = (text) => {
	const toast = [...document.querySelectorAll("#toast .toast")].find((t) => window.__j.visible(t) && window.__j.text(t) === text);
	return !!toast && toast.getBoundingClientRect().top > innerHeight / 2;
};

const toastText = () => {
	const el = document.querySelector("#toast .toast");
	return el && window.__j.visible(el) ? window.__j.text(el) : "";
};

const replyButtons = () => ["reply", "all", "forward"].every((mode) => window.__j.shown(document.querySelector(`#reply-slot [data-reply="${mode}"]`)));

const replyShown = () => [...document.querySelectorAll("form[data-composer]")].some(window.__j.visible);

// Inside the part of the screen the on-screen keyboard leaves visible.
const ABOVE_KEYBOARD = (selector) => {
	const el = [...document.querySelectorAll(selector)].find(window.__j.shown);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	const visibleBottom = visualViewport.offsetTop + visualViewport.height;
	return r.top >= visualViewport.offsetTop - 1 && r.bottom <= visibleBottom + 1 ? el.getAttribute("aria-label") || "shown" : null;
};

const outboxSize = () =>
	new Promise((resolve) => {
		const open = indexedDB.open("mailflare-offline");
		open.onerror = () => resolve(-1);
		open.onsuccess = () => {
			const db = open.result;
			if (!db.objectStoreNames.contains("outbox")) return resolve(0);
			const count = db.transaction("outbox").objectStore("outbox").count();
			count.onsuccess = () => resolve(count.result);
			count.onerror = () => resolve(-1);
		};
	});

// Drafts whose subject names the conversation ("Re: …").
const draftsFor = (subject) => [...document.querySelectorAll("li[data-row]")].filter((row) => window.__j.text(row.querySelector(".row-subject")).includes(subject)).length;

const airplane = (on) => [
	`Swipe down from the very top edge of the screen twice to open Quick Settings, and tap "Airplane mode" to turn it ${on ? "on" : "off"}`,
	async ({ device }) => {
		await device.openQuickSettings();
		await device.setAirplaneMode(on);
	},
];

const journey = {
	async setup({ device, state }) {
		await device.startSignedIn();
		// A conversation of its own, so no earlier run left a draft replying to it.
		const prefix = `Reply discard ${Date.now().toString(36)}`;
		await device.deliverMail(1, prefix);
		await waitFor(async () => {
			await device.goto(`${APP}/v2/inbox`);
			return device.eval((p) => window.__j.text(document.querySelector("li[data-row] .row-subject")).startsWith(p), prefix);
		}, { timeout: 30_000, interval: 1_000, message: `"${prefix}" at the top of the inbox` });
		state.subject = `${prefix} 1`;
		await device.settle();
		expect((await device.eval(outboxSize)) === 0, "the outbox is not empty at the start");
	},
	steps: [
		["Tap the first conversation in the inbox list", ({ device }) => device.tap("li[data-row] .row-subject", { effect: () => location.pathname.startsWith("/v2/inbox/"), effectTimeout: 8_000 })],
		[
			'Verify that the conversation opens with "Reply", "Reply all" and "Forward" buttons below the message',
			async ({ device, state }) => {
				await device.until((subject) => window.__j.byText("h1.thread-subject", subject), state.subject, { timeout: 10_000, message: `the "${state.subject}" conversation` });
				await device.until(replyButtons, null, { message: 'the "Reply", "Reply all" and "Forward" buttons' });
				await device.settle();
			},
		],
		['Tap "Reply"', ({ device }) => device.tap('#reply-slot [data-reply="reply"]', { effect: (sel) => !!document.querySelector(sel), arg: REPLY, effectTimeout: 8_000 })],
		[
			`Tap the message body of the reply and type "${BODY}"`,
			async ({ device }) => {
				await device.until((sel) => document.querySelector(sel)?.dataset.ready === "1", REPLY, { timeout: 10_000, message: "the reply to be ready" });
				await device.focus(`${REPLY} [data-editor]`);
				await device.typeInto(`${REPLY} [data-editor]`, BODY);
			},
		],
		[
			'Verify that the reply reads "Saved" within a few seconds',
			async ({ device }) => {
				// The composer saves 1.2 s after the last keystroke.
				await device.until((sel) => window.__j.text(document.querySelector(`${sel} [data-cmp-state]`)) === "Saved", REPLY, { timeout: 10_000, message: 'the reply to read "Saved"' }).catch(async (error) => {
					throw new Error(`${error.message}; it reads "${await device.eval((sel) => window.__j.text(document.querySelector(`${sel} [data-cmp-state]`)), REPLY)}"`);
				});
			},
		],
		airplane(true),
		[
			"Close Quick Settings",
			async ({ device }) => {
				await device.closeQuickSettings();
				await device.until(() => !navigator.onLine, null, { message: "the page to see the device offline" });
			},
		],
		[
			"Verify that the trash can button is visible on the screen and not covered by the keyboard; hide the keyboard with the Back button if it is covered",
			async ({ device }) => {
				if (await device.eval(ABOVE_KEYBOARD, `${REPLY} [data-cmp-discard]`)) return;
				await device.back();
				await device.until(ABOVE_KEYBOARD, `${REPLY} [data-cmp-discard]`, { message: "the trash can button to be visible after hiding the keyboard" });
			},
		],
		["Tap the trash can button to discard the reply", ({ device }) => device.tap(`${REPLY} [data-cmp-discard]`, { effect: (sel) => !document.querySelector(sel) || document.querySelector(sel).dataset.closed === "1", arg: REPLY, effectTimeout: 10_000 })],
		[
			'Verify that the reply closes, the "Reply", "Reply all" and "Forward" buttons are shown again, and "Draft discarded." appears near the bottom of the screen',
			async ({ device }) => {
				// Read once closing the reply is over: it reloads the conversation, which fails offline.
				await device.until(() => !document.querySelector(".htmx-request"), null, { message: "closing the reply to finish" });
				await device.until(() => ![...document.querySelectorAll("form[data-composer]")].some(window.__j.visible), null, { timeout: 10_000, message: "the reply to close" });
				await device.until(replyButtons, null, { timeout: 5_000, message: 'the "Reply", "Reply all" and "Forward" buttons to be back' });
				await device.until(toastNearBottom, DISCARDED, { timeout: 5_000, message: `"${DISCARDED}" near the bottom` }).catch(async (error) => {
					throw new Error(`${error.message}; the message reads "${await device.eval(toastText)}"`);
				});
			},
		],
		["Wait 3 seconds", () => sleep(3_000)],
		[
			'Verify that "Draft discarded." is still shown and the banner at the top reads "Offline" followed by "1 change waiting"',
			async ({ device }) => {
				const text = await device.eval(toastText);
				expect(text === DISCARDED, text ? `the message reads "${text}"` : "the message is gone");
				expect(!(await device.eval(replyShown)), "the reply is shown again");
				const shown = await device.eval(banner);
				expect(shown && /^Offline\b.*1 change waiting/.test(shown), `the banner reads "${shown}"`);
			},
		],
		airplane(false),
		[
			"Close Quick Settings and wait 15 seconds",
			async ({ device }) => {
				await device.closeQuickSettings();
				// Up to 15 s; stops early once the outbox has replayed and the banner has gone.
				await waitFor(async () => (await device.eval(outboxSize).catch(() => -1)) === 0 && !(await device.eval(banner).catch(() => "unknown")), { timeout: 15_000 }).catch(() => {});
			},
		],
		[
			"Verify that the banner is gone",
			async ({ device }) => {
				const text = await device.eval(banner);
				expect(!text, `the banner still reads "${text}"`);
			},
		],
		['Tap the menu button at the top left of the screen and tap "Drafts" in the drawer', ({ device }) => device.drawerTo("Drafts")],
		[
			"Verify that no draft replying to that conversation is listed in Drafts",
			async ({ device, state }) => {
				await device.until(() => location.pathname === "/v2/drafts" && window.__j.byText(".tb-title", "Drafts"), null, { message: "the Drafts list" });
				const count = await device.eval(draftsFor, state.subject);
				expect(count === 0, `${count} drafts replying to "${state.subject}" are listed in Drafts`);
			},
		],
	],
};

export default journey;
