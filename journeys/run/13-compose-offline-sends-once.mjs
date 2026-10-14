import { APP, expect, waitFor } from "./harness.mjs";

const SUBJECT = "Offline send journey";

const banner = () => {
	const el = document.querySelector("[data-offline-banner]");
	return el && window.__j.shown(el) ? window.__j.text(el) : null;
};

const composer = () => [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible) ?? null;

// Inside the part of the screen the on-screen keyboard leaves visible.
const ABOVE_KEYBOARD = (selector) => {
	const el = [...document.querySelectorAll(selector)].find(window.__j.shown);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	const visibleBottom = visualViewport.offsetTop + visualViewport.height;
	return r.top >= visualViewport.offsetTop - 1 && r.bottom <= visibleBottom + 1 ? window.__j.text(el) : null;
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

const titled = (subject) => [...document.querySelectorAll("li[data-row]")].filter((row) => window.__j.text(row.querySelector(".row-subject")) === subject).length;

const journey = {
	async setup({ device }) {
		await device.startSignedIn();
		// "No message with the subject in Sent or Drafts": move ones left by an earlier run on this server to Trash.
		const page = await device.page();
		const stale = await page.evaluate(async (subject) => {
			const ids = [];
			for (const list of ["/v2/sent", "/v2/drafts"]) {
				const doc = new DOMParser().parseFromString(await (await fetch(list)).text(), "text/html");
				ids.push(...[...doc.querySelectorAll("li[data-row]")].filter((row) => row.querySelector(".row-subject")?.textContent.trim() === subject).map((row) => row.dataset.id));
			}
			return ids;
		}, SUBJECT);
		if (stale.length) {
			const status = await page.evaluate(async (ids) => (await fetch("/api/messages/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageIds: ids, action: "trash" }) })).status, stale);
			expect(status === 200, `could not clear ${stale.length} earlier "${SUBJECT}" messages (${status})`);
			await device.goto(`${APP}/v2/inbox`);
		}
		await device.ensureServiceWorker();
		// Offline, the compose button opens the full-page composer from the cache. app.js asks the worker to
		// store it once per tab session, and that request is lost when the first page is reloaded before the
		// worker is ready (as ensureServiceWorker does): ask again the way a new session would.
		const composerStored = async () => {
			for (const name of await caches.keys()) {
				if (name.startsWith("mf-user-") && (await (await caches.open(name)).match(new URL("/v2/compose", location.href).href, { ignoreVary: true }))) return true;
			}
			return false;
		};
		if (!(await device.eval(composerStored))) {
			const inbox = await device.page();
			await inbox.evaluate(() => sessionStorage.removeItem("mf_compose_warm"));
			await inbox.reload({ waitUntil: "load" });
		}
		await device.until(composerStored, null, { timeout: 15_000, message: "the full-page composer to be stored for offline use" });
		expect((await device.eval(outboxSize)) === 0, "the outbox is not empty at the start");
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
			'Verify that the banner at the top of the inbox reads "Offline"',
			async ({ device }) => {
				const text = await device.until(banner, null, { message: "the offline banner" });
				expect(text.startsWith("Offline"), `the banner reads "${text}"`);
				const path = await device.eval(() => location.pathname);
				expect(path === "/v2/inbox", `the page is ${path}, not the inbox`);
			},
		],
		["Tap the round compose button with the pencil icon at the bottom right of the screen", ({ device }) => device.tap(".fab", { effect: () => !!document.querySelector("form[data-composer]") && window.__j.visible(document.querySelector("form[data-composer]")), effectTimeout: 10_000 })],
		[
			'Verify that a "New message" composer is shown with "From", "To" and "Subject" fields, a message area and a "Send" button',
			async ({ device }) => {
				await device.until(composer, null, { timeout: 15_000, message: "a composer" });
				await device.see("New message", { selector: "[data-cmp-title]" });
				await device.see(["From", "To"], { selector: "form[data-composer] label" });
				await device.see("Send", { selector: "[data-cmp-send]" });
				const fields = await device.eval(() => {
					const form = [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible);
					return { subject: window.__j.visible(form.querySelector('[data-cmp-subject][placeholder="Subject"]')), editor: window.__j.visible(form.querySelector("[data-editor]")) };
				});
				expect(fields.subject && fields.editor, `the Subject field or message area is missing (${JSON.stringify(fields)})`);
			},
		],
		[
			'Tap the "To" field and type "maya@acme.test", then tap the "Subject" field',
			async ({ device }) => {
				await device.focus('form[data-composer] input[id^="to-"]');
				await device.typeInto('form[data-composer] input[id^="to-"]', "maya@acme.test");
				await device.focus("form[data-composer] [data-cmp-subject]");
				// Leaving the field turns the address into a recipient.
				await device.until(() => {
					const form = document.querySelector("form[data-composer]");
					return form.querySelector('input[name="to"]')?.value.includes("maya@acme.test");
				}, null, { timeout: 5_000, message: 'the "To" field to hold maya@acme.test' });
			},
		],
		['Type "Offline send journey" into the "Subject" field', ({ device }) => device.typeInto("form[data-composer] [data-cmp-subject]", SUBJECT)],
		[
			'Tap the message area below the subject and type "Written and sent offline."',
			async ({ device }) => {
				await device.focus("form[data-composer] [data-editor]");
				await device.typeInto("form[data-composer] [data-editor]", "Written and sent offline.");
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
		['Tap the "Send" button', ({ device }) => device.tap("[data-cmp-send]", { effect: () => location.pathname !== "/v2/compose" || !document.querySelector("form[data-composer]") || document.querySelector("form[data-composer]").dataset.closed === "1", effectTimeout: 10_000 })],
		[
			"Verify that the composer closes, the inbox is shown, and a message saying the message will be sent when you're back online appears near the bottom of the screen",
			async ({ device }) => {
				await device.until(() => {
					const toast = [...document.querySelectorAll("#toast .toast")].find((t) => window.__j.visible(t) && /sent when you.re back online/.test(window.__j.text(t)));
					return location.pathname === "/v2/inbox" && !![...document.querySelectorAll("li[data-row]")].some(window.__j.shown) && ![...document.querySelectorAll("form[data-composer]")].some(window.__j.visible) && toast && toast.getBoundingClientRect().top > innerHeight / 2;
				}, null, { timeout: 15_000, message: "the inbox with \"…sent when you're back online\" near the bottom" });
			},
		],
		[
			'Verify that the banner at the top reads "Offline" followed by "1 change waiting"',
			async ({ device }) => {
				await device.until(() => {
					const el = document.querySelector("[data-offline-banner]");
					return el && window.__j.shown(el) && /^Offline\b.*1 change waiting/.test(window.__j.text(el));
				}, null, { message: 'the banner to read "Offline … 1 change waiting"' }).catch(async (error) => {
					throw new Error(`${error.message}; it reads "${await device.eval(banner)}"`);
				});
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
		[
			"Pull the inbox list down from just below the toolbar to refresh it, and wait 5 seconds",
			async ({ device }) => {
				const { page, box } = await device.locate("li[data-row]");
				const from = await device.toScreen(page, box.x, box.top + 4);
				await device.swipeScreen(from.x, from.y, from.x, device.height * 0.55, 1200);
				// Up to 5 s, until the refresh has finished.
				await device.settle({ timeout: 5_000 }).catch(() => {});
				await waitFor(async () => !(await device.eval(() => !!document.querySelector(".ptr.is-refreshing"))), { timeout: 5_000 }).catch(() => {});
			},
		],
		['Tap the menu button at the top left of the screen and tap "Sent" in the drawer', ({ device }) => device.drawerTo("Sent")],
		[
			'Verify that exactly one conversation with the subject "Offline send journey" is listed in Sent',
			async ({ device }) => {
				await device.until(() => location.pathname === "/v2/sent" && window.__j.byText(".tb-title", "Sent"), null, { message: "the Sent list" });
				const count = await device.eval(titled, SUBJECT);
				expect(count === 1, `${count} conversations titled "${SUBJECT}" are listed in Sent`);
			},
		],
		['Tap the menu button at the top left of the screen and tap "Drafts" in the drawer', ({ device }) => device.drawerTo("Drafts")],
		[
			'Verify that no draft with the subject "Offline send journey" is listed in Drafts',
			async ({ device }) => {
				await device.until(() => location.pathname === "/v2/drafts" && window.__j.byText(".tb-title", "Drafts"), null, { message: "the Drafts list" });
				const count = await device.eval(titled, SUBJECT);
				expect(count === 0, `${count} drafts titled "${SUBJECT}" are listed in Drafts`);
			},
		],
	],
};

export default journey;
