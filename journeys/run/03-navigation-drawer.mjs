import { APP, expect, fail } from "./harness.mjs";

const FOLDERS = ["Inbox", "Starred", "Snoozed", "Sent", "Drafts", "Archive", "All mail", "Spam", "Trash"];

const listHeading = (device) => device.eval(() => [...document.querySelectorAll(".tb-title")].map((el) => window.__j.text(el)).find(Boolean) ?? null);

const journey = {
	setup: ({ device }) => device.startSignedIn(),
	steps: [
		["Tap the menu button (three horizontal lines) at the top left of the screen", ({ device }) => device.tap("[data-nav-toggle]", { effect: () => document.body.classList.contains("nav-open") })],
		[
			'Verify that a drawer slides in from the left listing "Inbox", "Starred", "Snoozed", "Sent", "Drafts", "Archive", "All mail", "Spam" and "Trash", with "Settings" and "Switch to classic" at the bottom',
			async ({ device }) => {
				await waitDrawer(device, true);
				await device.see(FOLDERS, { selector: "#nav .nav-label" });
				await device.see(["Settings", "Switch to classic"], { selector: "#nav .sidebar-foot .nav-label" });
				const order = await device.eval(() => {
					const top = (text) => [...document.querySelectorAll("#nav .nav-label")].find((el) => window.__j.text(el) === text)?.getBoundingClientRect().top ?? -1;
					return { trash: top("Trash"), settings: top("Settings"), classic: top("Switch to classic") };
				});
				expect(order.settings > order.trash && order.classic > order.trash, `"Settings" and "Switch to classic" are not below the folders (${JSON.stringify(order)})`);
			},
		],
		[
			'Verify that the drawer does not show "Keyboard shortcuts"',
			({ device }) => device.gone("Keyboard shortcuts", { selector: "#nav .nav-label", timeout: 1_000 }),
		],
		[
			'Tap "Sent" in the drawer',
			({ device }) => device.tap({ selector: "#nav .nav-label", text: "Sent" }, { effect: () => location.pathname === "/v2/sent", effectTimeout: 8_000 }),
		],
		[
			'Verify that the drawer is closed and the list heading reads "Sent"',
			async ({ device }) => {
				await waitDrawer(device, false);
				await device.until(() => location.pathname === "/v2/sent" && [...document.querySelectorAll(".tb-title")].some((el) => window.__j.shown(el) && window.__j.text(el) === "Sent"), null, { message: 'the "Sent" list heading' });
			},
		],
		["Tap the menu button at the top left of the screen to open the drawer again", async ({ device }) => {
			await device.openDrawer();
			await waitDrawer(device, true);
		}],
		["Press the Android Back button once", ({ device }) => device.back()],
		[
			'Verify that the drawer is closed and the list heading still reads "Sent"',
			async ({ device }) => {
				await waitDrawer(device, false).catch(async (error) => {
					throw new Error(`${error.message}; the page is ${(await device.page()).url()}`);
				});
				const page = await device.page();
				expect(page.url() === `${APP}/v2/sent`, `Back left the Sent list: the page is now ${page.url()}`);
				const heading = await listHeading(device);
				expect(heading === "Sent", `the list heading reads "${heading}"`);
			},
		],
		["Press the Android Back button once more", ({ device }) => device.back()],
		[
			'Verify that the list heading reads "Inbox"',
			async ({ device }) => {
				await device.until(() => location.pathname === "/v2/inbox" && [...document.querySelectorAll(".tb-title")].some((el) => window.__j.shown(el) && window.__j.text(el) === "Inbox"), null, { message: 'the "Inbox" list heading after Back' }).catch(async (error) => {
					fail(`${error.message}; the page is ${(await device.page()).url()}, heading "${await listHeading(device)}"`);
				});
			},
		],
	],
};

async function waitDrawer(device, open) {
	const { waitFor } = await import("./harness.mjs");
	await waitFor(async () => (await device.drawerOpen().catch(() => false)) === open, { timeout: 5_000, message: `the drawer to be ${open ? "open" : "closed"}` });
}

export default journey;
