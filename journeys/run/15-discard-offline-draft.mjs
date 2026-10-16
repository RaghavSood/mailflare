import { APP, expect, waitFor } from "./harness.mjs";

const OFFLINE_SUBJECT = "Offline discard journey";
const SAVED_SUBJECT = "Saved draft discard journey";

const banner = () => {
	const el = document.querySelector("[data-offline-banner]");
	return el && window.__j.shown(el) ? window.__j.text(el) : null;
};

const composer = () => [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible) ?? null;

const composerState = () => {
	const form = [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible);
	return form ? window.__j.text(form.querySelector("[data-cmp-state]")) : null;
};

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

const titled = (subject) => [...document.querySelectorAll("li[data-row]")].filter((row) => window.__j.text(row.querySelector(".row-subject")) === subject).length;

const toastNearBottom = (text) => {
	const toast = [...document.querySelectorAll("#toast .toast")].find((t) => window.__j.visible(t) && window.__j.text(t) === text);
	return !!toast && toast.getBoundingClientRect().top > innerHeight / 2;
};

const airplane = (on) => [
	`Swipe down from the very top edge of the screen twice to open Quick Settings, and tap "Airplane mode" to turn it ${on ? "on" : "off"}`,
	async ({ device }) => {
		await device.openQuickSettings();
		await device.setAirplaneMode(on);
	},
];

const closeQuickSettingsOffline = [
	"Close Quick Settings",
	async ({ device }) => {
		await device.closeQuickSettings();
		await device.until(() => !navigator.onLine, null, { message: "the page to see the device offline" });
	},
];

const closeQuickSettingsAndWait = [
	"Close Quick Settings and wait 15 seconds",
	async ({ device }) => {
		await device.closeQuickSettings();
		// Up to 15 s; stops early once the outbox has replayed and the banner has gone.
		await waitFor(async () => (await device.eval(outboxSize).catch(() => -1)) === 0 && !(await device.eval(banner).catch(() => "unknown")), { timeout: 15_000 }).catch(() => {});
	},
];

const bannerGone = [
	"Verify that the banner is gone",
	async ({ device }) => {
		const text = await device.eval(banner);
		expect(!text, `the banner still reads "${text}"`);
	},
];

const tapCompose = ["Tap the round compose button with the pencil icon at the bottom right of the screen", ({ device }) => device.tap(".fab", { effect: () => !!document.querySelector("form[data-composer]") && window.__j.visible(document.querySelector("form[data-composer]")), effectTimeout: 10_000 })];

const typeRecipient = [
	'Tap the "To" field and type "maya@acme.test", then tap the "Subject" field',
	async ({ device }) => {
		await device.until(() => document.querySelector("form[data-composer]")?.dataset.ready === "1", null, { timeout: 10_000, message: "the composer to be ready" });
		await device.focus('form[data-composer] input[id^="to-"]');
		await device.typeInto('form[data-composer] input[id^="to-"]', "maya@acme.test");
		await device.focus("form[data-composer] [data-cmp-subject]");
		// Leaving the field turns the address into a recipient.
		await device.until(() => document.querySelector('form[data-composer] input[name="to"]')?.value.includes("maya@acme.test"), null, { timeout: 5_000, message: 'the "To" field to hold maya@acme.test' });
	},
];

const typeSubject = (subject) => [`Type "${subject}" into the "Subject" field`, ({ device }) => device.typeInto("form[data-composer] [data-cmp-subject]", subject)];

const composerReads = (state) => [
	`Verify that the composer reads "${state}" within a few seconds`,
	async ({ device }) => {
		// The composer saves 1.2 s after the last keystroke.
		await device.until((expected) => {
			const form = [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible);
			return form && window.__j.text(form.querySelector("[data-cmp-state]")) === expected;
		}, state, { timeout: 10_000, message: `the composer to read "${state}"` }).catch(async (error) => {
			throw new Error(`${error.message}; it reads "${await device.eval(composerState)}"`);
		});
	},
];

const discardVisible = [
	"Verify that the trash can button is visible on the screen and not covered by the keyboard; hide the keyboard with the Back button if it is covered",
	async ({ device }) => {
		if (await device.eval(ABOVE_KEYBOARD, "form[data-composer] [data-cmp-discard]")) return;
		await device.back();
		await device.until(ABOVE_KEYBOARD, "form[data-composer] [data-cmp-discard]", { message: "the trash can button to be visible after hiding the keyboard" });
	},
];

const tapDiscard = [
	"Tap the trash can button to discard the draft",
	({ device }) => device.tap("form[data-composer] [data-cmp-discard]", { effect: () => !document.querySelector("form[data-composer]") || document.querySelector("form[data-composer]").dataset.closed === "1", effectTimeout: 10_000 }),
];

const journey = {
	async setup({ device }) {
		await device.startSignedIn();
		// "No draft with either subject in Drafts": move ones left by an earlier run on this server to Trash.
		const page = await device.page();
		const stale = await page.evaluate(async (subjects) => {
			const doc = new DOMParser().parseFromString(await (await fetch("/v2/drafts")).text(), "text/html");
			return [...doc.querySelectorAll("li[data-row]")].filter((row) => subjects.includes(row.querySelector(".row-subject")?.textContent.trim())).map((row) => row.dataset.id);
		}, [OFFLINE_SUBJECT, SAVED_SUBJECT]);
		if (stale.length) {
			const status = await page.evaluate(async (ids) => (await fetch("/api/messages/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageIds: ids, action: "trash" }) })).status, stale);
			expect(status === 200, `could not clear ${stale.length} earlier drafts (${status})`);
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
		airplane(true),
		closeQuickSettingsOffline,
		[
			'Verify that the banner at the top of the inbox reads "Offline"',
			async ({ device }) => {
				const text = await device.until(banner, null, { message: "the offline banner" });
				expect(text.startsWith("Offline"), `the banner reads "${text}"`);
				const path = await device.eval(() => location.pathname);
				expect(path === "/v2/inbox", `the page is ${path}, not the inbox`);
			},
		],
		tapCompose,
		[
			'Verify that a "New message" composer is shown with "To" and "Subject" fields and a trash can button to discard the draft',
			async ({ device }) => {
				await device.until(composer, null, { timeout: 15_000, message: "a composer" });
				await device.see("New message", { selector: "[data-cmp-title]" });
				await device.see("To", { selector: "form[data-composer] label" });
				const fields = await device.eval(() => {
					const form = [...document.querySelectorAll("form[data-composer]")].find(window.__j.visible);
					return { subject: window.__j.visible(form.querySelector('[data-cmp-subject][placeholder="Subject"]')), discard: window.__j.shown(form.querySelector('[data-cmp-discard][aria-label="Discard draft"]')) };
				});
				expect(fields.subject && fields.discard, `the Subject field or the trash can button is missing (${JSON.stringify(fields)})`);
			},
		],
		typeRecipient,
		typeSubject(OFFLINE_SUBJECT),
		composerReads("Saved on this device"),
		discardVisible,
		tapDiscard,
		[
			'Verify that the composer closes, the inbox is shown, and "Draft discarded." appears near the bottom of the screen',
			async ({ device }) => {
				await device.until(() => location.pathname === "/v2/inbox" && !![...document.querySelectorAll("li[data-row]")].some(window.__j.shown) && ![...document.querySelectorAll("form[data-composer]")].some(window.__j.visible), null, { timeout: 15_000, message: "the inbox without a composer" });
				await device.until(toastNearBottom, "Draft discarded.", { timeout: 5_000, message: '"Draft discarded." near the bottom' });
			},
		],
		[
			'Verify that the banner at the top reads "Offline" and says no changes are waiting',
			async ({ device }) => {
				// The banner counts the outbox a moment after the page loads.
				await waitFor(async () => (await device.eval(outboxSize)) === 0, { timeout: 3_000 }).catch(() => {});
				const text = await device.until(banner, null, { message: "the offline banner" });
				expect(text.startsWith("Offline") && !/waiting/.test(text), `the banner reads "${text}"`);
				const queued = await device.eval(outboxSize);
				expect(queued === 0, `${queued} entries are still waiting in the outbox`);
			},
		],
		airplane(false),
		closeQuickSettingsAndWait,
		bannerGone,
		tapCompose,
		[
			// Online, the To field suggests contacts over the Subject field; a subject alone is a draft worth saving.
			`Tap the "Subject" field and type "${SAVED_SUBJECT}"`,
			async ({ device }) => {
				await device.until(() => document.querySelector("form[data-composer]")?.dataset.ready === "1", null, { timeout: 10_000, message: "the composer to be ready" });
				await device.focus("form[data-composer] [data-cmp-subject]");
				await device.typeInto("form[data-composer] [data-cmp-subject]", SAVED_SUBJECT);
			},
		],
		composerReads("Saved"),
		airplane(true),
		closeQuickSettingsOffline,
		discardVisible,
		tapDiscard,
		[
			'Verify that the composer closes and "Draft discarded." appears near the bottom of the screen',
			async ({ device }) => {
				await device.until(() => ![...document.querySelectorAll("form[data-composer]")].some(window.__j.visible), null, { timeout: 10_000, message: "the composer to close" });
				await device.until(toastNearBottom, "Draft discarded.", { timeout: 5_000, message: '"Draft discarded." near the bottom' });
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
		airplane(false),
		closeQuickSettingsAndWait,
		bannerGone,
		['Tap the menu button at the top left of the screen and tap "Drafts" in the drawer', ({ device }) => device.drawerTo("Drafts")],
		[
			'Verify that no draft with the subject "Offline discard journey" or "Saved draft discard journey" is listed in Drafts',
			async ({ device }) => {
				await device.until(() => location.pathname === "/v2/drafts" && window.__j.byText(".tb-title", "Drafts"), null, { message: "the Drafts list" });
				for (const subject of [OFFLINE_SUBJECT, SAVED_SUBJECT]) {
					const count = await device.eval(titled, subject);
					expect(count === 0, `${count} drafts titled "${subject}" are listed in Drafts`);
				}
			},
		],
	],
};

export default journey;
