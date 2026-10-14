import { APP, expect, waitFor } from "./harness.mjs";

const fitsWidth = () => document.documentElement.scrollWidth <= innerWidth;
// A classic row's link is display: contents, so the row is the link's parent.
const rowSelector = '*:has(> a[href^="/inbox/msg_"])';
const hasRows = (sel) => [...document.querySelectorAll(sel)].some(window.__j.shown);
const listShows = (heading) => location.pathname === `/v2/${heading.toLowerCase()}` && [...document.querySelectorAll(".tb-title")].some((el) => window.__j.shown(el) && window.__j.text(el) === heading);
const sidebarOpen = () => {
	const el = document.querySelector("#app-sidebar");
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.left >= -1 && r.right > 40 && window.__j.visible(el);
};

const journey = {
	async setup({ device }) {
		await device.startSignedIn();
		// The classic inbox lists one mailbox (support@ unless another was picked): make sure it has mail.
		await device.goto(`${APP}/inbox`);
		const listed = await waitFor(() => device.eval(hasRows, rowSelector), { timeout: 8_000, message: "classic rows" }).catch(() => false);
		if (!listed) {
			await device.deliverMail(1, "Classic journey mail");
			await waitFor(async () => {
				await device.goto(`${APP}/inbox`);
				return waitFor(() => device.eval(hasRows, rowSelector), { timeout: 4_000, message: "classic rows" }).catch(() => false);
			}, { timeout: 30_000, interval: 500, message: "the delivered mail in the classic inbox" });
		}
		await device.goto(`${APP}/v2/inbox`);
		await device.settle();
	},
	steps: [
		[
			'Tap the menu button at the top left of the screen and tap "Archive" in the drawer',
			async ({ device }) => {
				await device.openDrawer();
				await device.tap({ selector: "#nav .nav-label", text: "Archive" }, { effect: () => location.pathname === "/v2/archive", effectTimeout: 8_000 });
			},
		],
		['Verify that the list heading reads "Archive"', ({ device }) => device.until(listShows, "Archive", { message: 'the "Archive" list heading' })],
		["Press the Android Back button once", ({ device }) => device.back()],
		['Verify that the list heading reads "Inbox"', ({ device }) => device.until(listShows, "Inbox", { message: 'the "Inbox" list heading after Back' })],
		[
			'Tap the menu button at the top left of the screen and tap "Switch to classic" at the bottom of the drawer',
			async ({ device }) => {
				await device.openDrawer();
				// Where it lands is the next step's check: after Back from Archive, a stale link opened the classic archive (#30).
				await device.tap({ selector: "#nav .nav-label", text: "Switch to classic" }, { effect: () => !location.pathname.startsWith("/v2"), effectTimeout: 15_000 });
				await device.settle();
			},
		],
		[
			"Verify that the classic inbox (not the archive) is shown with a menu button at the top left, a search field, and message rows that fit the screen width without a horizontal scrollbar",
			async ({ device }) => {
				const path = await device.eval(() => location.pathname);
				expect(path === "/inbox", `"Switch to classic" opened ${path}, not the classic inbox`);
				await device.until((sel) => location.pathname === "/inbox" && [...document.querySelectorAll(sel)].some(window.__j.shown), rowSelector, { timeout: 20_000, message: "classic inbox rows" });
				const state = await device.eval(({ sel }) => {
					const menu = document.querySelector('button[aria-label="Open menu"]');
					const m = menu?.getBoundingClientRect();
					const search = [...document.querySelectorAll('input[type="search"], input[placeholder*="Search" i]')].find(window.__j.shown);
					const rows = [...document.querySelectorAll(sel)].filter(window.__j.visible);
					return {
						menu: !!menu && window.__j.shown(menu) && m.left < innerWidth / 4 && m.top < 160,
						search: !!search,
						rowsFit: rows.length > 0 && rows.every((row) => row.getBoundingClientRect().right <= innerWidth + 0.5),
						noScroll: document.documentElement.scrollWidth <= innerWidth,
					};
				}, { sel: rowSelector });
				expect(state.menu && state.search && state.rowsFit && state.noScroll, `classic inbox layout: ${JSON.stringify(state)}`);
			},
		],
		[
			"Tap the first message row",
			async ({ device, state }) => {
				state.href = await device.eval((sel) => [...document.querySelectorAll(sel)].find(window.__j.shown).querySelector(":scope > a").getAttribute("href"), rowSelector);
				await device.tap(rowSelector, { effect: (href) => location.pathname === href, arg: state.href, effectTimeout: 10_000 });
			},
		],
		[
			"Verify that the message is shown full screen with a back button at the top left, and the message list is hidden",
			async ({ device }) => {
				await device.until((sel) => {
					const back = document.querySelector('[aria-label="Back to list"]');
					if (!back || !window.__j.shown(back)) return false;
					const b = back.getBoundingClientRect();
					const listShown = [...document.querySelectorAll(sel)].some(window.__j.shown);
					return b.left < innerWidth / 4 && b.top < 200 && !listShown;
				}, rowSelector, { timeout: 15_000, message: "the message full screen with a back button and no list" });
			},
		],
		[
			"Tap the back button at the top left of the message",
			({ device }) => device.tap('[aria-label="Back to list"]', { effect: () => location.pathname === "/inbox", effectTimeout: 10_000 }),
		],
		[
			"Verify that the classic message list is shown again",
			({ device }) => device.until((sel) => location.pathname === "/inbox" && [...document.querySelectorAll(sel)].some(window.__j.shown), rowSelector, { timeout: 15_000, message: "the classic message list" }),
		],
		["Tap the menu button at the top left of the screen", ({ device }) => device.tap('button[aria-label="Open menu"]', { effect: sidebarOpen })],
		[
			'Verify that a drawer opens from the left showing "Compose" and the mailbox folders ("Inbox", "Sent", "Drafts", "Archived", "Spam", "Trash")',
			async ({ device }) => {
				await device.until(sidebarOpen, null, { message: "the classic drawer open" });
				await device.see(["Compose", "Inbox", "Sent", "Drafts", "Archived", "Spam", "Trash"], { selector: "#app-sidebar a, #app-sidebar button, #app-sidebar span" });
			},
		],
		[
			"Tap outside the drawer on the darkened area to the right",
			async ({ device }) => {
				const right = await device.eval(() => {
					const r = document.querySelector("#app-sidebar").getBoundingClientRect();
					return { x: (r.right + innerWidth) / 2, y: innerHeight / 2 };
				});
				const page = await device.page();
				const at = await device.toScreen(page, right.x, right.y);
				await device.tapScreen(at.x, at.y);
			},
		],
		["Verify that the drawer is closed", ({ device }) => device.until(() => !document.querySelector("#app-sidebar") || document.querySelector("#app-sidebar").getBoundingClientRect().right <= 1 || !window.__j.visible(document.querySelector("#app-sidebar")), null, { message: "the classic drawer to close" })],
		[
			'Tap the round account avatar at the top right of the screen and tap "Settings" in the menu that opens',
			async ({ device }) => {
				await device.tap('button[aria-label="Open account menu"]', { effect: () => [...document.querySelectorAll("a, button")].some((el) => window.__j.shown(el) && window.__j.text(el) === "Settings") });
				await device.tap({ selector: "a, button", text: "Settings" }, { effect: () => location.pathname.startsWith("/settings"), effectTimeout: 15_000 });
				await device.settle();
			},
		],
		[
			'Verify that settings sections are shown as a horizontal row of tabs at the top (including "Account") and the settings content fits the screen width',
			async ({ device }) => {
				await device.until(() => {
					const nav = document.querySelector('nav[aria-label="Settings"]');
					if (!nav || !window.__j.visible(nav)) return false;
					const links = [...nav.querySelectorAll("a")].filter(window.__j.visible);
					const oneRow = links.length > 1 && links.every((a) => Math.abs(a.getBoundingClientRect().top - links[0].getBoundingClientRect().top) < 4);
					return oneRow && nav.getBoundingClientRect().top < 250 && links.some((a) => window.__j.text(a) === "Account");
				}, null, { timeout: 15_000, message: 'a row of settings tabs at the top including "Account"' });
				expect(await device.eval(fitsWidth), "the settings page is wider than the screen");
			},
		],
		[
			"Press the Android Back button once to return to the classic inbox",
			async ({ device }) => {
				await device.back();
				await device.until(() => location.pathname === "/inbox", null, { timeout: 15_000, message: "the classic inbox after Back" });
				await device.settle();
			},
		],
		[
			'Tap the round button with a sparkle icon at the top right, next to the search field (its label is "Switch to the new interface")',
			({ device }) => device.tap('a[title="Switch to the new interface"]', { effect: () => location.pathname.startsWith("/v2"), effectTimeout: 15_000 }),
		],
		[
			'Verify that the v2 inbox is shown with the "Search mail" field and the round compose button',
			({ device }) => device.until(() => location.pathname === "/v2/inbox" && window.__j.shown(document.querySelector('input[placeholder="Search mail"]')) && [...document.querySelectorAll(".fab")].some(window.__j.shown), null, { timeout: 15_000, message: 'the v2 inbox with "Search mail" and the compose button' }),
		],
	],
};

export default journey;
