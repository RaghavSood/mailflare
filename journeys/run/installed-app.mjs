// The installed Mailflare app (a Chrome-hosted web app: Chrome mints no WebAPK for http://localhost)
// and the launcher it is pinned to. Journey 02 installs it as its actions; journey 22 starts with it
// installed and, on a device where 02 has not run (CI runs them on different emulators), installs it
// the same way as setup.
import { sleep, waitFor } from "./harness.mjs";

export const chrome = (n) => n.pkg === "com.android.chrome";
export const launcher = (n) => /launcher/.test(n.pkg);
export const homeIcon = (n) => launcher(n) && n.clickable && /^Mailflare$/.test(n.desc || n.text);

/** What the launcher shows now (one home screen page, or the app drawer), top to bottom. */
export const launcherNodes = async (device) => (await device.nativeNodes()).filter((n) => launcher(n) && n.bounds);
export const labelsOf = (nodes) => nodes.filter((n) => n.desc || n.text).map((n) => n.desc || n.text);

const focus = (device) => device.shell("dumpsys window | grep -m1 mCurrentFocus 2>/dev/null");

/** The device clock, for reading the launcher's log from a moment on (see placedOnPage). */
export async function deviceNow(device) {
	return Number((await device.shell("date +%s")).trim()) - 2;
}

/**
 * Where the launcher put Chrome's new shortcut: the home screen page index it logged when it placed it
 * (null until then). Accepting the pin only queues the shortcut; the launcher places it when it next
 * comes to the front, on the first page with room (page 1 on the CI image, beside "At a glance").
 */
export async function placedOnPage(device, since) {
	const log = await device.shell(`logcat -d -v epoch -T ${since}.000 -s AddWorkspaceItemsTask:D 2>/dev/null`);
	const placed = [...log.matchAll(/targetComponent=ComponentInfo\{com\.android\.chrome\/[^}]*\} screen=(\d+)/g)].at(-1);
	return placed ? Number(placed[1]) : null;
}

/**
 * Shows home screen page `index`: Home (from the home screen it goes back to the first page), then one
 * swipe left per page. A swipe the launcher drops (it ignores touches while it settles) leaves the same
 * page on screen, so each swipe is checked and made again until the page changes. Returns its labels.
 */
export async function showHomePage(device, index) {
	await device.home();
	await sleep(400);
	await device.home();
	let nodes = await waitFor(async () => {
		const now = await launcherNodes(device);
		return labelsOf(now).length ? now : null;
	}, { timeout: 10_000, message: "the launcher's home screen" });
	for (let page = 0; page < index; page++) {
		let moved = null;
		for (let swipe = 1; swipe <= 3 && !moved; swipe++) {
			await device.swipeScreen(device.width * 0.85, device.height * 0.5, device.width * 0.15, device.height * 0.5, 300);
			moved = await waitFor(async () => {
				const now = await launcherNodes(device);
				return labelsOf(now).length && labelsOf(now).join("|") !== labelsOf(nodes).join("|") ? now : null;
			}, { timeout: 3_000, interval: 300, message: `home screen page ${page + 2}` }).catch(() => null);
		}
		if (!moved) return { nodes, reached: page };
		nodes = moved;
	}
	return { nodes, reached: index };
}

/**
 * The Mailflare icon on the home screen, looking through the first `pages` pages until `timeout`, on the
 * page the launcher logged for a shortcut pinned since `since` once it has. Returns { icon, seen }.
 */
export async function findHomeIcon(device, { since = null, timeout = 0, pages = 3 } = {}) {
	const deadline = Date.now() + timeout;
	const seen = [];
	let page = null;
	for (let look = 0; ; look++) {
		if (page === null && since !== null) page = await placedOnPage(device, since);
		const target = page ?? look % pages;
		const shown = await showHomePage(device, target);
		const icon = shown.nodes.find(homeIcon) ?? null;
		seen.push(`page ${shown.reached + 1}: ${icon ? "the icon" : labelsOf(shown.nodes).slice(0, 12).join(", ") || "nothing"}`);
		if (icon) return { icon, seen };
		if (look >= pages - 1 && Date.now() > deadline) return { icon: null, seen };
		if (look >= pages - 1) await sleep(1_000);
	}
}

/** Whether the installed app's window is in front (WebappActivity, or WebApkActivity for a WebAPK). */
export async function appInFront(device) {
	return /WebappActivity|WebApkActivity/.test(await focus(device));
}

/** Chrome's own browser UI (tab switcher, omnibox) on screen, by resource id. */
export async function chromeBrowserUi(device) {
	return (await device.nativeNodes()).filter((n) => chrome(n) && /url_bar|tab_switcher_button|location_bar/.test(n.id)).map((n) => n.id.split("/").pop());
}

/**
 * Installs the app from Chrome's menu as journey 02's actions do, with Chrome in front on a v2 page.
 * Returns the device time to read the launcher's placement from (see placedOnPage).
 */
export async function installFromMenu(device) {
	await device.tapNative((n) => chrome(n) && /menu_button$/.test(n.id), { message: "Chrome's menu button" });
	await device.tapNative((n) => chrome(n) && /^(Add to home screen|Install app)$/i.test(n.text), { message: '"Add to home screen" or "Install app" in the menu' });
	const choice = await device.findNative((n) => chrome(n) && (/option_text_install$/.test(n.id) || /app_name$/.test(n.id)), { message: "Chrome's install sheet or dialog" });
	if (/option_text_install$/.test(choice.id)) await device.tapNative((n) => chrome(n) && /option_text_install$/.test(n.id), { message: 'the "Install" option' });
	const since = await deviceNow(device);
	await device.tapNative((n) => chrome(n) && /positive_button$/.test(n.id), { message: 'the "Install" button' });
	const isConfirm = (n) => launcher(n) && n.clickable && /^(Add|Add automatically|Add to home screen)$/i.test(n.text);
	const confirm = await device.findNative(isConfirm, { timeout: 15_000, message: "the launcher's confirmation" }).catch(() => null);
	if (confirm) await device.tapScreen((confirm.bounds.x1 + confirm.bounds.x2) / 2, (confirm.bounds.y1 + confirm.bounds.y2) / 2);
	await waitFor(async () => !(await device.nativeNodes()).some((n) => launcher(n) && /^(Add automatically|Add to home screen)$/i.test(n.text) && n.clickable), { timeout: 6_000, message: "the confirmation to close" });
	return since;
}
