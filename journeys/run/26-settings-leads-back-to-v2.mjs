import { expect } from "./harness.mjs";

const onSettings = () => location.pathname.startsWith("/settings/");
const sidebarOpen = () => {
	const el = document.querySelector("#app-sidebar");
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.left >= -1 && r.right > 40 && window.__j.visible(el);
};
const listShows = (heading) => location.pathname === `/v2/${heading.toLowerCase()}` && [...document.querySelectorAll(".tb-title")].some((el) => window.__j.shown(el) && window.__j.text(el) === heading);

/** v2 drawer → Settings. Where it lands is checked by the step after. */
async function openSettings(device) {
	await device.openDrawer();
	await device.tap({ selector: "#nav .nav-label", text: "Settings" }, { effect: onSettings, effectTimeout: 15_000 });
	await device.settle();
}

/** The classic drawer on the settings page → a mail folder. A link that stays classic fails the step after, not this one. */
async function tapSettingsDrawer(device, label) {
	await device.until(() => window.__j.shown(document.querySelector('button[aria-label="Open menu"]')), null, { timeout: 15_000, message: "the settings menu button" });
	await device.tap('button[aria-label="Open menu"]', { effect: sidebarOpen });
	await device.tap({ selector: "#app-sidebar a span", text: label }, { effect: () => !location.pathname.startsWith("/settings/"), effectTimeout: 15_000 });
	await device.settle();
}

const journey = {
	async setup({ device }) {
		await device.startSignedIn();
		await device.settle();
	},
	steps: [
		['Tap the menu button at the top left of the screen and tap "Settings" in the drawer', ({ device }) => openSettings(device)],
		[
			'Verify that settings sections are shown as a horizontal row of tabs at the top (including "Account")',
			({ device }) => device.until(() => {
				const nav = document.querySelector('nav[aria-label="Settings"]');
				if (!nav || !window.__j.visible(nav)) return false;
				const links = [...nav.querySelectorAll("a")].filter(window.__j.visible);
				const oneRow = links.length > 1 && links.every((a) => Math.abs(a.getBoundingClientRect().top - links[0].getBoundingClientRect().top) < 4);
				return oneRow && nav.getBoundingClientRect().top < 250 && links.some((a) => window.__j.text(a) === "Account");
			}, null, { timeout: 15_000, message: 'a row of settings tabs at the top including "Account"' }),
		],
		['Tap the menu button at the top left of the screen and tap "Inbox" in the drawer', ({ device }) => tapSettingsDrawer(device, "Inbox")],
		[
			'Verify that the v2 inbox is shown with the "Search mail" field and the round compose button',
			async ({ device }) => {
				const path = await device.eval(() => location.pathname);
				expect(path === "/v2/inbox", `"Inbox" in the settings drawer opened ${path}, not the v2 inbox`);
				await device.until(() => location.pathname === "/v2/inbox" && window.__j.shown(document.querySelector('input[placeholder="Search mail"]')) && [...document.querySelectorAll(".fab")].some(window.__j.shown), null, { timeout: 15_000, message: 'the v2 inbox with "Search mail" and the compose button' });
			},
		],
		['Tap the menu button at the top left of the screen and tap "Settings" in the drawer', ({ device }) => openSettings(device)],
		['Tap the menu button at the top left of the screen and tap "Archived" in the drawer', ({ device }) => tapSettingsDrawer(device, "Archived")],
		[
			'Verify that the v2 list heading reads "Archive"',
			async ({ device }) => {
				const path = await device.eval(() => location.pathname);
				expect(path === "/v2/archive", `"Archived" in the settings drawer opened ${path}, not the v2 archive`);
				await device.until(listShows, "Archive", { timeout: 15_000, message: 'the v2 "Archive" list heading' });
			},
		],
	],
};

export default journey;
