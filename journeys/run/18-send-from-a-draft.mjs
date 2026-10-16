import { APP, expect, sleep } from "./harness.mjs";

const SUBJECT = "Draft send journey";

// Inside the part of the screen the on-screen keyboard leaves visible.
const ABOVE_KEYBOARD = (selector) => {
	const el = [...document.querySelectorAll(selector)].find(window.__j.shown);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	const visibleBottom = visualViewport.offsetTop + visualViewport.height;
	return r.top >= visualViewport.offsetTop - 1 && r.bottom <= visibleBottom + 1 ? window.__j.text(el) : null;
};

const composerState = () => {
	const form = [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible);
	return form ? window.__j.text(form.querySelector("[data-cmp-state]")) : null;
};

const titled = (subject) => [...document.querySelectorAll("li[data-row]")].filter((row) => window.__j.text(row.querySelector(".row-subject")) === subject).length;

const DRAFT_PATH = /^\/v2\/drafts\/[A-Za-z0-9_-]+$/;

const journey = {
	async setup({ device }) {
		await device.startSignedIn();
		// "No message with the subject in Drafts or Sent": move ones left by an earlier run on this server to Trash.
		const page = await device.page();
		const stale = await page.evaluate(async (subject) => {
			const ids = [];
			for (const path of ["/v2/drafts", "/v2/sent"]) {
				const doc = new DOMParser().parseFromString(await (await fetch(path)).text(), "text/html");
				ids.push(...[...doc.querySelectorAll("li[data-row]")].filter((row) => row.querySelector(".row-subject")?.textContent.trim() === subject).map((row) => row.dataset.id));
			}
			return ids;
		}, SUBJECT);
		if (stale.length) {
			const status = await page.evaluate(async (ids) => (await fetch("/api/messages/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageIds: ids, action: "trash" }) })).status, stale);
			expect(status === 200, `could not clear ${stale.length} earlier "${SUBJECT}" messages (${status})`);
			await device.goto(`${APP}/v2/inbox`);
		}
	},
	steps: [
		["Tap the round compose button with the pencil icon at the bottom right of the screen", ({ device }) => device.tap(".fab", { effect: () => [...document.querySelectorAll("form[data-composer]")].some(window.__j.visible), effectTimeout: 10_000 })],
		[
			'Tap the "To" field, type "maya" and tap the "Maya Chen" suggestion',
			async ({ device }) => {
				await device.until(() => document.querySelector("form[data-composer]")?.dataset.ready === "1", null, { timeout: 10_000, message: "the composer to be ready" });
				await device.focus('form[data-composer] input[id^="to-"]');
				await device.typeInto('form[data-composer] input[id^="to-"]', "maya");
				await device.tap({ selector: ".rcpt-suggest:not([hidden]) .rcpt-option", text: /Maya Chen/ }, { effect: () => !!document.querySelector("form[data-composer] .rcpt-chip") });
				await device.until(() => document.querySelector('form[data-composer] input[name="to"]')?.value.includes("maya@acme.test"), null, { timeout: 5_000, message: 'the "To" field to hold maya@acme.test' });
			},
		],
		['Tap the "Subject" field', ({ device }) => device.focus("form[data-composer] [data-cmp-subject]")],
		[`Type "${SUBJECT}" into the "Subject" field`, ({ device }) => device.typeInto("form[data-composer] [data-cmp-subject]", SUBJECT)],
		[
			'Verify that the composer reads "Saved" within a few seconds',
			async ({ device }) => {
				// The composer saves 1.2 s after the last keystroke.
				await device.until(() => {
					const form = [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible);
					return form && window.__j.text(form.querySelector("[data-cmp-state]")) === "Saved" && !!form.elements.draftId.value;
				}, null, { timeout: 10_000, message: 'the composer to read "Saved"' }).catch(async (error) => {
					throw new Error(`${error.message}; it reads "${await device.eval(composerState)}"`);
				});
			},
		],
		[
			'Tap the "Save and close" button with the X icon at the top right of the composer',
			({ device }) => device.tap('form[data-composer] [data-cmp-close][aria-label="Save and close"]', { effect: () => document.querySelector("form[data-composer]")?.dataset.closed === "1" || location.pathname !== "/v2/compose", effectTimeout: 10_000 }),
		],
		[
			"Verify that the composer closes and the inbox is shown",
			({ device }) =>
				device.until(() => location.pathname === "/v2/inbox" && !!window.__j.byText(".tb-title", "Inbox") && ![...document.querySelectorAll("form[data-composer]")].some(window.__j.visible), null, { timeout: 15_000, message: "the inbox without a composer" }),
		],
		[
			'Tap the menu button at the top left of the screen and tap "Drafts" in the drawer',
			async ({ device }) => {
				await device.drawerTo("Drafts");
			},
		],
		[
			`Tap the draft with the subject "${SUBJECT}"`,
			async ({ device }) => {
				await device.until(() => location.pathname === "/v2/drafts" && window.__j.byText(".tb-title", "Drafts"), null, { message: "the Drafts list" });
				await device.tap({ selector: "li[data-row] .row-subject", text: SUBJECT }, { effect: (path) => new RegExp(path).test(location.pathname), arg: DRAFT_PATH.source, effectTimeout: 8_000 });
			},
		],
		[
			`Verify that the draft opens in a composer filling the screen, with "${SUBJECT}" in the "Subject" field and a recipient chip for maya@acme.test in the "To" field`,
			async ({ device }) => {
				await device.until(() => {
					const form = [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible);
					if (!form || form.dataset.ready !== "1") return null;
					const r = form.getBoundingClientRect();
					return r.width >= innerWidth - 1 && r.height >= visualViewport.height * 0.6;
				}, null, { timeout: 15_000, message: "a composer filling the screen" });
				const state = await device.eval(() => {
					const form = [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible);
					const chips = [...form.querySelectorAll('.cmp-field:has(input[id^="to-"]) .rcpt-chip')].filter(window.__j.visible).map((chip) => chip.title || window.__j.text(chip));
					return { path: location.pathname, subject: form.querySelector("[data-cmp-subject]").value, chips };
				});
				expect(DRAFT_PATH.test(state.path), `the page is ${state.path}, not a draft`);
				expect(state.subject === SUBJECT, `the Subject field reads "${state.subject}"`);
				expect(state.chips.some((chip) => chip.includes("maya@acme.test")), `the "To" field shows ${JSON.stringify(state.chips)}`);
			},
		],
		[
			'Verify that the "Send" button is visible on the screen and not covered by the keyboard; hide the keyboard with the Back button if it is covered',
			async ({ device }) => {
				if (await device.eval(ABOVE_KEYBOARD, "[data-cmp-send]")) return;
				await device.back();
				await device.until(ABOVE_KEYBOARD, "[data-cmp-send]", { message: "the Send button to be visible after hiding the keyboard" });
			},
		],
		['Tap the "Send" button', ({ device }) => device.tap("[data-cmp-send]", { effect: () => ![...document.querySelectorAll("form[data-composer]")].some(window.__j.visible) || document.querySelector("form[data-composer]")?.dataset.closed === "1", effectTimeout: 20_000 })],
		[
			'Verify that the composer closes and a message reading "Message sent." appears near the bottom of the screen',
			async ({ device }) => {
				await device.until(() => {
					const toast = [...document.querySelectorAll("#toast .toast")].find((t) => window.__j.visible(t) && window.__j.text(t).includes("Message sent."));
					const composer = [...document.querySelectorAll("form[data-composer]")].some(window.__j.visible);
					return toast && !composer && toast.getBoundingClientRect().top > innerHeight / 2;
				}, null, { timeout: 20_000, message: 'the composer to close and "Message sent." near the bottom' });
			},
		],
		[
			`Verify that the Drafts list is shown with the "Drafts" heading, that the page's address is the Drafts list and no longer the draft's, and that "${SUBJECT}" is not listed`,
			async ({ device }) => {
				await device.until(() => window.__j.byText(".tb-title", "Drafts") && document.querySelector("#main .page[data-page=list]"), null, { message: "the Drafts list" });
				// The address bar shows the page's own address; the page reads it as location.
				await sleep(500);
				const path = await device.eval(() => location.pathname);
				expect(path === "/v2/drafts", `the address is ${path} while the Drafts list is shown`);
				const count = await device.eval(titled, SUBJECT);
				expect(count === 0, `${count} drafts titled "${SUBJECT}" are still listed`);
			},
		],
		[
			"Swipe slowly downwards starting near the top of the list, ending near the middle of the screen",
			async ({ device }) => {
				// Watch (without touching anything) for the refresh indicator, the list being swapped and an
				// error toast, and mark this document so a full reload would show.
				await device.eval(() => {
					const list = document.querySelector("#list-form");
					window.__jPtr = { document: true, indicator: false, list, toasts: [] };
					new MutationObserver(() => {
						if (document.querySelector(".ptr.is-refreshing, .ptr.is-armed")) window.__jPtr.indicator = true;
						for (const toast of document.querySelectorAll("#toast .toast")) {
							const text = window.__j.text(toast);
							if (text && !window.__jPtr.toasts.includes(text)) window.__jPtr.toasts.push(text);
						}
					}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true, characterData: true });
				});
				// The top of the list: its first row, or the empty-list note when no draft is left.
				const { page, box } = await device.locate("#main .page[data-page=list] .list :is(li[data-row], .empty)");
				const from = await device.toScreen(page, box.x, box.top + Math.min(40, box.height / 2));
				await device.swipeScreen(from.x, from.y, from.x, device.height * 0.55, 1200);
			},
		],
		[
			"Verify that a refresh indicator appears at the top of the list, or that the list has refreshed",
			({ device }) =>
				device.until(() => window.__jPtr && (window.__jPtr.indicator || (!window.__jPtr.list.isConnected && document.querySelector("#list-form"))), null, { message: "a refresh indicator or a refreshed list" }),
		],
		[
			'Verify that the Drafts list is still shown with the "Drafts" heading, and that no "Not found" page, error message or browser error page is shown',
			async ({ device }) => {
				const state = await device.until(() => {
					if (document.querySelector(".ptr.is-refreshing, .htmx-request")) return null;
					return {
						path: location.pathname,
						title: document.title,
						sameDocument: !!window.__jPtr?.document,
						refreshed: !window.__jPtr?.list.isConnected,
						heading: !!window.__j.byText(".tb-title", "Drafts"),
						list: !!document.querySelector("#main .page[data-page=list]"),
						empty: window.__j.text(document.querySelector("#main .page[data-page=empty]") ?? document.createElement("i")),
						toasts: window.__jPtr?.toasts ?? [],
					};
				}, null, { timeout: 15_000, message: "the refresh to finish" });
				expect(!state.empty && !/^Not found/.test(state.title), `a "Not found" page is shown: "${state.empty || state.title}"`);
				expect(!state.toasts.some((text) => /went wrong|not found|offline/i.test(text)), `an error message appeared: ${JSON.stringify(state.toasts)}`);
				expect(state.sameDocument, "the page was reloaded in full");
				expect(state.path === "/v2/drafts" && state.heading && state.list, `the Drafts list is not shown (${JSON.stringify(state)})`);
				expect(state.refreshed, "the list was not refreshed");
			},
		],
		[
			'Tap the menu button at the top left of the screen and tap "Sent" in the drawer',
			async ({ device }) => {
				await device.drawerTo("Sent");
			},
		],
		[
			`Verify that exactly one conversation with the subject "${SUBJECT}" is listed in Sent`,
			async ({ device }) => {
				await device.until(() => location.pathname === "/v2/sent" && window.__j.byText(".tb-title", "Sent"), null, { message: "the Sent list" });
				const count = await device.eval(titled, SUBJECT);
				expect(count === 1, `${count} conversations titled "${SUBJECT}" are listed in Sent`);
			},
		],
	],
};

export default journey;
