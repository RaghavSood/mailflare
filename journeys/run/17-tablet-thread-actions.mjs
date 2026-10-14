import { APP, expect, sleep } from "./harness.mjs";

// The CI device is a phone: the journey makes it a 1280×800 screen at density 200, which Chrome
// lays out 1024 CSS pixels wide (the tablet band), and puts the phone back in teardown, which the
// runner calls after a failed or timed-out step too.
async function tabletScreen(device, on) {
	await device.shell(on ? "wm size 1280x800 && wm density 200" : "wm size reset && wm density reset");
	const size = (await device.shell("wm size")).match(/(\d+)x(\d+)\s*$/m);
	device.width = Number(size[1]);
	device.height = Number(size[2]);
}

const MENU = '#main .msg.is-last details[data-menu="message"]';
const DETAILS = "#main .msg.is-last .msg-recipients [data-details]";
const MENU_OPEN = () => !!document.querySelector('#main .msg.is-last details[data-menu="message"][open]');
const DETAILS_SHOWN = () => [...document.querySelectorAll("#main .page .msg-details")].some((el) => !el.hidden && el.textContent.trim());
// The second `input tap` starts this long after the first; locally that lands it a few ms after the
// conversation is swapped in, inside the 20 ms htmx used to wait before wiring it up (#31).
const GAP_MS = 30;

/** Where `selector` sits on the open conversation, in page pixels. */
const centreOf = (selector) => {
	const el = document.querySelector(selector);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/**
 * Taps the first row, then `selector` where the conversation will show it (learnt in setup), from two
 * `input tap` processes started GAP_MS apart: as quickly as adb allows. A second touch that lands on
 * the conversation stands, whatever it did. One that lands before the conversation is shown (a slow
 * device) or is lost touched the list, not the conversation, so it is tapped again once the
 * conversation is on screen: the step never fails because the device was slow.
 */
async function openAndTapAtOnce(device, state, selector, effect) {
	await device.until(() => location.pathname === "/v2/inbox" && [...document.querySelectorAll("#main .page li[data-row]")].some(window.__j.shown), null, { message: "the inbox list" });
	const { page, box: row } = await device.locate("#main .page li[data-row] .row-subject");
	const from = await device.toScreen(page, row.x, row.y);
	const where = await device.toScreen(page, state.targets[selector].x, state.targets[selector].y);
	await device.eval(() => {
		// Back restores the list without a new document, so an earlier step's listeners are still here:
		// each pair records only into its own object.
		const t0 = performance.now();
		const mine = (window.__jAtOnce = { downs: [], swap: null });
		addEventListener("pointerdown", (event) => mine.downs.push({ t: Math.round(performance.now() - t0), on: window.__j.describe(event.target) }), { capture: true });
		document.addEventListener("htmx:afterSwap", (event) => {
			if (event.detail.target?.id === "main" && mine.swap === null) mine.swap = Math.round(performance.now() - t0);
		});
	});
	await device.shell(`input tap ${Math.round(from.x)} ${Math.round(from.y)} & sleep ${(GAP_MS / 1000).toFixed(3)}; input tap ${Math.round(where.x)} ${Math.round(where.y)}; wait`);
	await device.until(() => !!document.querySelector("#main .page[data-page=thread]"), null, { timeout: 8_000, message: "the conversation to open" }).catch(() => null);
	await sleep(300);
	const seen = await device.eval(() => window.__jAtOnce ?? null).catch(() => null);
	const second = seen?.downs[1];
	const late = second && seen.swap !== null ? second.t - seen.swap : null;
	device.log(`  second touch ${late === null ? `not seen on the conversation (${JSON.stringify(seen)})` : `${late} ms after the conversation was swapped in`}${second ? ` (on ${second.on})` : ""}`);
	if (late !== null && late >= 0) return;
	device.log("  it reached the list instead; tapping again now that the conversation is shown");
	if (!(await device.eval(() => !!document.querySelector("#main .page[data-page=thread]")))) {
		await device.tap("#main .page li[data-row] .row-subject", { effect: () => !!document.querySelector("#main .page[data-page=thread]"), effectTimeout: 8_000 });
	}
	// An early touch on another row may still be opening that conversation: let it finish first.
	await device.until(() => !document.body.classList.contains("is-loading") && !!document.querySelector("#main > .split-list li[data-row]"), null, { message: "the conversation and its list to finish loading" });
	// A touch that did reach the conversation already opened it; another would close it again.
	if (await device.eval(effect)) return;
	await device.tap(selector, { effect });
}

/** The conversation's subject when it is shown to the right of the list pane, with its row marked there. */
const besideList = () => {
	const pane = document.querySelector("#main > .split-list");
	const page = document.querySelector("#main > .page[data-page=thread]");
	if (!pane || !page || !window.__j.visible(pane) || !pane.querySelector("li[data-row].is-current")) return null;
	const subject = document.querySelector("h1.thread-subject");
	return subject && pane.getBoundingClientRect().right <= page.getBoundingClientRect().left + 1 ? window.__j.text(subject) : null;
};

const touches = (device) => device.eval(() => JSON.stringify(window.__jAtOnce ?? null)).catch(() => "?");

const journey = {
	setup: async ({ device, state }) => {
		await tabletScreen(device, true);
		await device.startSignedIn();
		await device.until(() => matchMedia("(min-width: 900px) and (max-width: 1199px)").matches && [...document.querySelectorAll("#main li[data-row]")].some(window.__j.shown), null, { message: "Chrome to lay the inbox out in the tablet band" });
		// Learn where the first conversation shows its menu and details toggle. Open it twice, so it is
		// read (and scrolled) as it will be when the journey opens it.
		const href = await device.eval(() => document.querySelector("#main li[data-row]")?.dataset.href);
		expect(href, "the inbox has no conversation");
		for (let visit = 0; visit < 2; visit++) {
			await device.goto(new URL(href, APP).href);
			await device.until(() => document.querySelector("#main > .split-list li[data-row]") && document.querySelector("#main .msg.is-last"), null, { message: "the conversation beside its list" });
			await sleep(500);
		}
		state.targets = {};
		for (const selector of [`${MENU} > summary`, DETAILS]) {
			state.targets[selector] = await device.eval(centreOf, selector);
			expect(state.targets[selector], `the conversation has no ${selector}`);
		}
		await device.goto(`${APP}/v2/inbox`);
		// The first touches after a full page load are often dropped; spend them on the heading.
		await device.tap(".tb-title");
		await device.tap(".tb-title");
	},
	teardown: ({ device }) => tabletScreen(device, false),
	steps: [
		[
			"Tap the first conversation in the inbox list and, as quickly as possible after it, tap the three-dot button to the right of the message date",
			({ device, state }) => openAndTapAtOnce(device, state, `${MENU} > summary`, MENU_OPEN),
		],
		[
			'Verify that the conversation is shown beside the list of conversations, with a menu open next to the button listing "Reply", "Reply all", "Forward" and "Mark unread from here"',
			async ({ device }) => {
				await device.until(besideList, null, { timeout: 10_000, message: "the conversation beside the list of conversations" });
				// A dropdown under the button, not a sheet along the bottom edge of the screen.
				const placed = await device.until((menu) => {
					const summary = document.querySelector(`${menu}[open] > summary`);
					const panel = document.querySelector(`${menu}[open] .menu-panel`);
					if (!summary || !panel || !window.__j.visible(panel)) return null;
					const s = summary.getBoundingClientRect(), p = panel.getBoundingClientRect();
					return { below: p.top >= s.bottom - 4 && p.top - s.bottom < 40, nearX: p.right >= s.left && p.left <= s.right, narrow: p.width < innerWidth * 0.8 };
				}, MENU, { timeout: 3_000, message: "the message menu to be open" }).catch(async (error) => {
					throw new Error(`${error.message}; touches ${await touches(device)}`);
				});
				expect(placed.below && placed.nearX && placed.narrow, `the menu is not a dropdown next to the button (${JSON.stringify(placed)})`);
				await device.see(["Reply", "Reply all", "Forward", "Mark unread from here"], { selector: 'details[data-menu="message"][open] .menu-item' });
			},
		],
		["Press the Android Back button once", ({ device }) => device.back()],
		[
			"Verify that the inbox list is shown",
			({ device }) => device.until(() => location.pathname === "/v2/inbox" && window.__j.byText(".tb-title", "Inbox") && [...document.querySelectorAll("#main .page li[data-row]")].some(window.__j.shown), null, { timeout: 10_000, message: "the inbox list after Back" }),
		],
		[
			"Tap the first conversation in the inbox list and, as quickly as possible after it, tap the small down-arrow next to the recipients under the sender's name",
			({ device, state }) => openAndTapAtOnce(device, state, DETAILS, DETAILS_SHOWN),
		],
		[
			'Verify that the conversation is shown beside the list of conversations, with a panel showing "from:", "to:", "date:" and "subject:" details',
			async ({ device }) => {
				await device.until(besideList, null, { timeout: 10_000, message: "the conversation beside the list of conversations" });
				const text = await device.until(() => {
					const panel = [...document.querySelectorAll("#main .page .msg-details")].find((el) => !el.hidden && el.textContent.trim() && window.__j.visible(el));
					return panel ? window.__j.text(panel) : null;
				}, null, { timeout: 5_000, message: "the details panel to be shown" }).catch(async (error) => {
					throw new Error(`${error.message}; touches ${await touches(device)}`);
				});
				for (const label of ["from:", "to:", "date:", "subject:"]) expect(text.toLowerCase().includes(label), `the details panel does not show "${label}" (it shows: ${text.slice(0, 120)})`);
			},
		],
	],
};

export default journey;
