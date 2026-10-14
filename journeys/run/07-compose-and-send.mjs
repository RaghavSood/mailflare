import { APP, expect, sleep } from "./harness.mjs";

const SUBJECT = "Journey send test";

// Inside the part of the screen the on-screen keyboard leaves visible.
const ABOVE_KEYBOARD = (selector) => {
	const el = [...document.querySelectorAll(selector)].find(window.__j.shown);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	const visibleBottom = visualViewport.offsetTop + visualViewport.height;
	return r.top >= visualViewport.offsetTop - 1 && r.bottom <= visibleBottom + 1 ? window.__j.text(el) : null;
};

const journey = {
	async setup({ device }) {
		await device.startSignedIn();
		// "Exactly one" in Sent: move sends left by an earlier run on this server to Trash.
		const page = await device.page();
		const stale = await page.evaluate(async (subject) => {
			const doc = new DOMParser().parseFromString(await (await fetch("/v2/sent")).text(), "text/html");
			return [...doc.querySelectorAll("li[data-row]")].filter((row) => row.querySelector(".row-subject")?.textContent.trim() === subject).map((row) => row.dataset.id);
		}, SUBJECT);
		if (stale.length) {
			const status = await page.evaluate(async (ids) => (await fetch("/api/messages/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageIds: ids, action: "trash" }) })).status, stale);
			expect(status === 200, `could not clear ${stale.length} earlier "${SUBJECT}" sends (${status})`);
			await device.goto(`${APP}/v2/inbox`);
		}
	},
	steps: [
		["Tap the round compose button with the pencil icon at the bottom right of the screen", ({ device }) => device.tap(".fab", { effect: () => [...document.querySelectorAll("form[data-composer]")].some(window.__j.visible), effectTimeout: 8_000 })],
		[
			'Verify that a "New message" composer fills the screen with "From", "To" and "Subject" fields, a message area and a "Send" button, and that the on-screen keyboard is open',
			async ({ device }) => {
				await device.until(() => {
					const form = [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible);
					if (!form) return null;
					const r = form.getBoundingClientRect();
					return r.width >= innerWidth - 1 && r.height >= visualViewport.height * 0.6;
				}, null, { timeout: 15_000, message: "a composer filling the screen" });
				await device.see("New message", { selector: "[data-cmp-title]" });
				await device.see(["From", "To"], { selector: "form[data-composer] label" });
				await device.see("Send", { selector: "[data-cmp-send]" });
				const fields = await device.eval(() => {
					const form = [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible);
					return { subject: window.__j.visible(form.querySelector('[data-cmp-subject][placeholder="Subject"]')), editor: window.__j.visible(form.querySelector("[data-editor]")) };
				});
				expect(fields.subject && fields.editor, `the Subject field or message area is missing (${JSON.stringify(fields)})`);
				const open = await device.keyboardShown() || (await sleep(1500), await device.keyboardShown());
				expect(open, "the on-screen keyboard is not open");
			},
		],
		[
			'Type "maya" into the "To" field',
			async ({ device }) => {
				const focused = await device.eval(() => document.activeElement?.matches?.("form[data-composer] [data-recipients]:not([data-cmp-row] *)"));
				if (!focused) await device.focus('form[data-composer] input[id^="to-"]');
				await device.typeInto('form[data-composer] input[id^="to-"]', "maya");
			},
		],
		[
			'Verify that a suggestion showing "Maya Chen" and "maya@acme.test" is visible above the keyboard',
			async ({ device }) => {
				const text = await device.until(ABOVE_KEYBOARD, ".rcpt-suggest:not([hidden]) .rcpt-option", { message: "a recipient suggestion above the keyboard" });
				expect(text.includes("Maya Chen") && text.includes("maya@acme.test"), `the suggestion reads "${text}"`);
			},
		],
		['Tap the "Maya Chen" suggestion', ({ device }) => device.tap({ selector: ".rcpt-suggest:not([hidden]) .rcpt-option", text: /Maya Chen/ }, { effect: () => !!document.querySelector("form[data-composer] .rcpt-chip") })],
		[
			'Verify that the "To" field now shows a recipient chip for Maya Chen',
			({ device }) => device.see("Maya Chen", { selector: 'form[data-composer] .cmp-field:has(input[id^="to-"]) .rcpt-chip' }),
		],
		[
			'Tap the "Subject" field and type "Journey send test"',
			async ({ device }) => {
				await device.focus("form[data-composer] [data-cmp-subject]");
				await device.typeInto("form[data-composer] [data-cmp-subject]", SUBJECT);
			},
		],
		[
			'Tap the message area below the subject and type "Sent from the compose journey."',
			async ({ device }) => {
				await device.focus("form[data-composer] [data-editor]");
				await device.typeInto("form[data-composer] [data-editor]", "Sent from the compose journey.");
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
		['Tap the "Send" button', ({ device }) => device.tap("[data-cmp-send]", { effect: () => ![...document.querySelectorAll("form[data-composer]")].some(window.__j.visible) || !!document.querySelector("[data-cmp-send][disabled], form[data-composer].is-sending"), effectTimeout: 20_000 })],
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
			'Tap the menu button at the top left of the screen and tap "Sent" in the drawer',
			async ({ device }) => {
				await device.drawerTo("Sent");
			},
		],
		[
			'Verify that exactly one conversation with the subject "Journey send test" is listed in Sent',
			async ({ device }) => {
				await device.until(() => location.pathname === "/v2/sent" && window.__j.byText(".tb-title", "Sent"), null, { message: "the Sent list" });
				const count = await device.eval((subject) => [...document.querySelectorAll("li[data-row]")].filter((row) => window.__j.text(row.querySelector(".row-subject")) === subject).length, SUBJECT);
				expect(count === 1, `${count} conversations titled "${SUBJECT}" are listed in Sent`);
			},
		],
	],
};

export default journey;
