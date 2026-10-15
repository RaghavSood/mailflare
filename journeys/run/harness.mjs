// Deterministic driver for the journeys in ../*.journey.xml. Interaction goes through the device
// (adb `input` taps, swipes and key events, Quick Settings state through `cmd`); Chrome DevTools is
// only used to wait for and assert on the page and to find where an element is on screen.
import { execFile } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { promisify } from "node:util";
import { _android, chromium } from "playwright-core";
import { displayOverrides, inRegion, keyboardRegion } from "./report-utils.mjs";

const exec = promisify(execFile);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const APP = "http://localhost:3000";
// A static same-origin page for setup work (signing in through the API, calibrating touches). The
// sign-in page starts background requests, and leaving it while they stream has made wrangler dev
// exit ("Network connection lost" in its dev proxy), so setup does not go through it.
export const BLANK = `${APP}/v2-assets/offline`;
export const LOGIN = { email: "admin@example.com", password: "demo-password-change-me" };

export class StepError extends Error {}

export function fail(message) {
	throw new StepError(message);
}

export function expect(condition, message) {
	if (!condition) fail(message);
}

/** Polls `check` until it returns a truthy value; the last falsy value or error explains a timeout. */
export async function waitFor(check, { timeout = 10_000, interval = 200, message = "condition" } = {}) {
	const deadline = Date.now() + timeout;
	let last;
	for (;;) {
		try {
			const value = await check();
			if (value) return value;
			last = value;
		} catch (error) {
			if (error instanceof StepError) throw error;
			last = error?.message ?? String(error);
		}
		if (Date.now() > deadline) fail(`Timed out after ${timeout} ms waiting for ${message}${last ? ` (last: ${typeof last === "string" ? last : JSON.stringify(last)})` : ""}`);
		await sleep(interval);
	}
}

/**
 * Does `act`, then waits up to `timeout` for `done`; does it once more only if `done` still does not hold.
 * What a touch does can show after the wait has given up (the page was busy), and doing it again then
 * acts on what the first touch changed (taps the drawer's scrim, swipes the next row), so `done` is
 * given `grace` more before the second try.
 */
export async function retryUnlessDone(act, done, { timeout, grace = 1_500, message, log = () => {} }) {
	for (let attempt = 1; ; attempt++) {
		await act(attempt);
		const ok = await waitFor(done, { timeout, message }).catch((error) => (attempt >= 2 ? Promise.reject(error) : false));
		if (ok) return ok;
		const late = await waitFor(done, { timeout: grace, message }).catch(() => false);
		if (late) {
			log(`  ${message}: happened late, after ${timeout} ms`);
			return late;
		}
		log(`  ${message}: did not happen; once more`);
	}
}

// Runs inside the page: helpers for what a person on the device can see.
const PAGE_HELPERS = `(() => {
	if (window.__j) return;
	const visible = (el) => {
		if (!el || !el.isConnected) return false;
		const r = el.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) return false;
		if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
		for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
			const style = getComputedStyle(node);
			if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
		}
		return true;
	};
	const centre = (el) => {
		const r = el.getBoundingClientRect();
		const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
		const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
		return { x: (left + right) / 2, y: (top + bottom) / 2 };
	};
	// On screen and not covered by something else at its centre.
	const shown = (el) => {
		if (!visible(el)) return false;
		const c = centre(el);
		const hit = document.elementFromPoint(c.x, c.y);
		return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
	};
	const text = (el) => (el.innerText ?? el.textContent ?? "").replace(/\\s+/g, " ").trim();
	const describe = (el) => {
		if (!el) return "nothing";
		const label = text(el).slice(0, 40);
		return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "") + (label ? ' "' + label + '"' : "");
	};
	// The smallest shown element matching the selector whose text matches.
	const byText = (selector, pattern) => {
		const re = typeof pattern === "string" ? null : pattern;
		const matches = [...document.querySelectorAll(selector)].filter((el) => {
			const t = text(el) || el.getAttribute("aria-label") || el.value || "";
			return re ? re.test(t) : t === pattern;
		});
		return matches.filter(shown).sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0] ?? null;
	};
	window.__j = { visible, shown, centre, text, describe, byText };
})()`;

/** Page function: the v2 drawer is open, slid in and on screen. */
const DRAWER_OPEN = () => {
	const nav = document.querySelector("#nav");
	const r = nav.getBoundingClientRect();
	return document.body.classList.contains("nav-open") && r.right > innerWidth / 2 && r.left >= -1 && window.__j.visible(nav);
};

export class Device {
	constructor({ serial, hostPort = 3000, cdpPort = 9222, log = () => {} }) {
		this.serial = serial;
		this.hostPort = hostPort;
		this.cdpPort = cdpPort;
		this.log = log;
		this.browser = null;
		this.calibration = new WeakMap();
	}

	async open() {
		const devices = await _android.devices();
		this.android = this.serial ? devices.find((d) => d.serial() === this.serial) : devices[0];
		if (!this.android) throw new Error(`No adb device${this.serial ? ` ${this.serial}` : ""} (found ${devices.map((d) => d.serial()).join(", ") || "none"})`);
		this.serial = this.android.serial();
		const size = (await this.shell("wm size")).match(/(\d+)x(\d+)\s*$/m);
		this.width = Number(size[1]);
		this.height = Number(size[2]);
		await this.startRelay();
		await this.adb("reverse", "tcp:3000", `tcp:${this.relayPort}`);
	}

	/**
	 * The device's localhost:3000 reaches the server through this relay. Going offline closes every
	 * connection through it and refuses new ones: Airplane mode does not touch the adb reverse tunnel,
	 * and Chrome keeps connections alive, so removing the tunnel alone left pages able to reach the server.
	 */
	/**
	 * Puts the display back to the device's own size and density if something left it overridden (a
	 * journey that changes it, cut off before its teardown), and returns what was overridden ([] if nothing).
	 */
	async resetDisplay() {
		const overrides = displayOverrides(await this.shell("wm size"), await this.shell("wm density"));
		if (overrides.length) await this.shell("wm size reset && wm density reset");
		const size = (await this.shell("wm size")).match(/(\d+)x(\d+)\s*$/m);
		this.width = Number(size[1]);
		this.height = Number(size[2]);
		return overrides;
	}

	async startRelay() {
		this.relayOffline = false;
		this.relaySockets = new Set();
		this.relay = createServer((client) => {
			if (this.relayOffline) return client.destroy();
			const upstream = createConnection({ host: "127.0.0.1", port: this.hostPort });
			const pair = [client, upstream];
			for (const socket of pair) {
				this.relaySockets.add(socket);
				socket.on("error", () => pair.forEach((s) => s.destroy()));
				socket.on("close", () => {
					this.relaySockets.delete(socket);
					pair.forEach((s) => s.destroy());
				});
			}
			client.pipe(upstream);
			upstream.pipe(client);
		});
		await new Promise((resolve) => this.relay.listen(0, "127.0.0.1", resolve));
		this.relay.unref();
		this.relayPort = this.relay.address().port;
	}

	setRelayOffline(offline) {
		this.relayOffline = offline;
		if (offline) for (const socket of this.relaySockets) socket.destroy();
	}

	// Every device command is capped: one hung adb call must fail its step, not stall the whole shard.
	async adb(...args) {
		const { stdout } = await exec("adb", ["-s", this.serial, ...args], { maxBuffer: 32 * 1024 * 1024, encoding: "buffer", timeout: 30_000 });
		return stdout;
	}

	async shell(command) {
		let timer;
		const out = await Promise.race([
			this.android.shell(command),
			new Promise((_, reject) => (timer = setTimeout(() => reject(new StepError(`adb shell "${command.slice(0, 60)}" did not finish within 30 s`)), 30_000))),
		]).finally(() => clearTimeout(timer));
		return out.toString("utf8");
	}

	async tapScreen(x, y) {
		await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
	}

	async swipeScreen(x1, y1, x2, y2, ms = 300) {
		await this.shell(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${ms}`);
	}

	async back() {
		await this.shell("input keyevent 4");
	}

	async home() {
		await this.shell("input keyevent 3");
	}

	async enter() {
		await this.shell("input keyevent 66");
	}

	/** Types through the on-screen keyboard's input connection, as a person typing would. */
	async type(text) {
		// Typing with nothing focused would fire the app's keyboard shortcuts instead.
		await this.until(() => {
			const el = document.activeElement;
			return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName));
		}, null, { timeout: 5_000, message: "a text field to have focus before typing" });
		const escaped = text.replace(/[\\'"`$&|;<>()*?#~!{}[\]]/g, (c) => `\\${c}`).replace(/ /g, "%s");
		await this.shell(`input text '${escaped.replace(/'/g, "'\\''")}'`);
	}

	async screenshot(path) {
		await this.android.screenshot({ path });
	}

	async keyboardShown() {
		const out = await this.shell("dumpsys input_method | grep -m1 mInputShown");
		return /mInputShown=true/.test(out);
	}

	/** Where on the screen touches go to the on-screen keyboard ([] while it is hidden). */
	async keyboardRegion() {
		return keyboardRegion(await this.shell("dumpsys window InputMethod"));
	}

	/**
	 * Device offline the way the journeys mean it: Airplane mode, plus the server cut off (see startRelay).
	 * `serverReachable: false` with `offline: false` turns Airplane mode off but keeps the server cut off,
	 * the "server not reachable yet" moment after a reconnect.
	 */
	async setOffline(offline, { serverReachable = !offline } = {}) {
		if (!serverReachable) this.setRelayOffline(true);
		await this.shell(`cmd connectivity airplane-mode ${offline ? "enable" : "disable"}`);
		if (serverReachable) {
			this.setRelayOffline(false);
			await this.adb("reverse", "tcp:3000", `tcp:${this.relayPort}`);
		}
	}

	async airplaneMode() {
		return (await this.shell("settings get global airplane_mode_on")).trim() === "1";
	}

	/**
	 * Opens the full Quick Settings panel. Stands in for "swipe down from the very top edge twice": an
	 * `input swipe` that starts on the status bar is not reliably taken as the shade gesture, and the
	 * journeys are about the app, not the gesture. The Airplane mode tile itself is still tapped.
	 */
	async openQuickSettings() {
		// A busy SystemUI opens the panel late or drops the request: ask again only once it still is not open.
		await retryUnlessDone(() => this.shell("cmd statusbar expand-settings"), () => this.shadeOpen(), { timeout: 3_000, message: "Quick Settings to open", log: this.log });
		await sleep(500);
	}

	/**
	 * Whether the notification shade or Quick Settings is open, as SystemUI itself reports it. The window
	 * manager's focus and visibility flags for the shade both lag behind by seconds.
	 */
	async shadeOpen() {
		const state = await this.shell("dumpsys activity service com.android.systemui/.SystemUIService 2>/dev/null | grep -m1 'mExpandedVisible='");
		return /mExpandedVisible=true/.test(state);
	}

	/**
	 * Closes Quick Settings with `cmd statusbar collapse`, the counterpart of opening it. Back first
	 * collapses the full panel to the notification shade and only then closes it, and with the shade's
	 * state reported late a second Back can land on the page and navigate it.
	 */
	async closeQuickSettings() {
		// SystemUI can drop the request while it is busy (say, reconnecting Wi-Fi after Airplane mode): ask again.
		for (let attempt = 1; ; attempt++) {
			await this.shell("cmd statusbar collapse");
			const closed = await waitFor(async () => !(await this.shadeOpen()), { timeout: 5_000, message: "Quick Settings to close" }).catch((error) => (attempt >= 3 ? Promise.reject(error) : false));
			if (closed) return;
			this.log("  Quick Settings still open; collapsing again");
		}
	}

	/**
	 * Turns Airplane mode on or off while Quick Settings is open. This stands in for tapping the tile,
	 * whose place differs between images (the CI image opens the shade with one row of tiles), with the
	 * same system setting: `cmd connectivity airplane-mode`. Turning it on also cuts the server off
	 * (Airplane mode does not cut the adb reverse tunnel; see startRelay); turning it off restores it,
	 * unless `{ serverReachable: false }` is given (see setOffline).
	 */
	async setAirplaneMode(on, options) {
		await this.setOffline(on, options);
		await waitFor(async () => (await this.airplaneMode()) === on, { timeout: 5_000, message: `Airplane mode to turn ${on ? "on" : "off"}` });
		if (on) {
			// Confirm from the page that the server really is out of reach.
			const page = await this.page().catch(() => null);
			if (page) {
				const reached = await this.evaluate(page, () => fetch(`/login?offline-check=${Date.now()}`, { cache: "no-store" }).then(() => true, () => false)).catch(() => false);
				if (reached) fail("the page can still reach the server after going offline");
			}
		}
	}

	/** Swipes away a Chrome message bubble (such as "Save password?") if one shows up within `timeout`. */
	async dismissChromeMessage(text, { timeout = 4_000 } = {}) {
		const node = await this.findNative((n) => n.pkg === "com.android.chrome" && text.test(n.text), { timeout, message: `Chrome's ${text} message` }).catch(() => null);
		if (!node) return false;
		const y = (node.bounds.y1 + node.bounds.y2) / 2;
		await this.swipeScreen(this.width / 2, y, this.width / 2, 0, 200);
		await waitFor(async () => !(await this.nativeNodes()).some((n) => n.pkg === "com.android.chrome" && text.test(n.text)), { timeout: 5_000, message: `Chrome's ${text} message to go away` });
		return true;
	}

	/** The mean colour of a screen rectangle, from a raw `screencap` (RGBA after a small header). */
	async meanColour({ x1, y1, x2, y2 }) {
		const raw = await this.adb("exec-out", "screencap");
		const w = raw.readUInt32LE(0);
		const h = raw.readUInt32LE(4);
		const header = raw.length - w * h * 4;
		let r = 0, g = 0, b = 0, n = 0;
		for (let y = Math.max(0, y1); y < Math.min(h, y2); y++) {
			for (let x = Math.max(0, x1); x < Math.min(w, x2); x++) {
				const o = header + (y * w + x) * 4;
				r += raw[o];
				g += raw[o + 1];
				b += raw[o + 2];
				n++;
			}
		}
		return { r: r / n, g: g / n, b: b / n };
	}

	// Native UI (Chrome menus and dialogs, the launcher) through uiautomator.
	async nativeNodes() {
		const xml = await this.shell("uiautomator dump /data/local/tmp/journey-ui.xml >/dev/null 2>&1; cat /data/local/tmp/journey-ui.xml; rm -f /data/local/tmp/journey-ui.xml");
		return [...xml.matchAll(/<node ([^>]*?)\/?>/g)].map(([, attrs]) => {
			const get = (name) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
			const b = get("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
			return {
				text: decodeXml(get("text")),
				desc: decodeXml(get("content-desc")),
				id: get("resource-id"),
				pkg: get("package"),
				clickable: get("clickable") === "true",
				focused: get("focused") === "true",
				bounds: b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null,
			};
		});
	}

	async findNative(match, { timeout = 10_000, message } = {}) {
		const test = typeof match === "function" ? match : (n) => match.test(n.text) || match.test(n.desc);
		return waitFor(async () => (await this.nativeNodes()).find((n) => n.bounds && test(n)), { timeout, interval: 300, message: message ?? `native element ${match}` });
	}

	async tapNative(match, options) {
		const node = await this.findNative(match, options);
		await this.tapScreen((node.bounds.x1 + node.bounds.x2) / 2, (node.bounds.y1 + node.bounds.y2) / 2);
		return node;
	}

	// Chrome DevTools, forwarded from the device's chrome_devtools_remote socket.
	async connect() {
		await this.adb("forward", `tcp:${this.cdpPort}`, "localabstract:chrome_devtools_remote");
		this.browser = await waitFor(
			async () => {
				const res = await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`).catch(() => null);
				if (!res?.ok) return null;
				return chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
			},
			{ timeout: 60_000, interval: 500, message: "Chrome DevTools on the device" },
		);
		this.browser.on("disconnected", () => {
			this.browser = null;
		});
	}

	pages() {
		return this.browser ? this.browser.contexts().flatMap((c) => c.pages()) : [];
	}

	/**
	 * The Mailflare page in front. Chrome on Android can report background tabs as "visible", so the
	 * front one is the page that is painting frames.
	 */
	async page({ timeout = 10_000 } = {}) {
		return waitFor(
			async () => {
				if (!this.browser) await this.connect();
				const candidates = this.pages().filter((p) => p.url().startsWith(APP));
				if (candidates.length <= 1) return candidates[0] ?? null;
				const painting = [];
				for (const p of candidates) {
					const frame = await this.evaluate(p, () => Promise.race([new Promise((r) => requestAnimationFrame(() => r(document.visibilityState === "visible"))), new Promise((r) => setTimeout(() => r(false), 400))])).catch(() => false);
					if (frame) painting.push(p);
				}
				const front = painting.at(-1) ?? null;
				// Never leave two Mailflare tabs open: DevTools could watch one while touches go to the other.
				if (front) for (const p of candidates) if (p !== front) await p.close().catch(() => {});
				return front;
			},
			{ timeout, message: "a localhost:3000 page in front in Chrome" },
		);
	}

	/** Closes every tab but the one in front, so later lookups are unambiguous. */
	async singleTab() {
		const front = await this.page();
		for (const p of this.pages()) if (p !== front) await p.close().catch(() => {});
		return front;
	}

	async eval(fn, arg, { page } = {}) {
		const p = page ?? (await this.page());
		await this.evaluate(p, PAGE_HELPERS);
		return this.evaluate(p, fn, arg);
	}

	/**
	 * page.evaluate with a deadline. A DevTools call to a page that went away (Chrome restarted, the tab
	 * replaced) can wait forever, which turned a 30 s wait into a step timed out with no reason. Past the
	 * deadline the connection is dropped, so the next lookup connects afresh, and the error says what is
	 * in front; it is a plain Error, so waitFor keeps polling until its own deadline.
	 */
	async evaluate(page, fn, arg, { timeout = 10_000 } = {}) {
		let timer;
		const call = page.evaluate(fn, arg);
		call.catch(() => {});
		try {
			return await Promise.race([call, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), timeout)))]);
		} catch (error) {
			if (error.message !== "timeout") throw error;
			this.browser = null;
			const front = (await this.shell("dumpsys window 2>/dev/null | grep -m1 mCurrentFocus").catch(() => "")).trim().replace(/^.*\{[^ ]+ u0 /, "").replace(/\}$/, "");
			throw new Error(`Chrome DevTools did not answer within ${timeout / 1000} s (in front: ${front || "unknown"})`);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Waits until `fn` (run in the page with window.__j helpers) returns something truthy. Survives navigations. */
	async until(fn, arg, { timeout = 10_000, message } = {}) {
		return waitFor(() => this.eval(fn, arg), { timeout, message: message ?? String(fn) });
	}

	/** Waits until each text (exact string or RegExp) is shown on screen in an element matching `selector`. */
	async see(texts, { selector = "*", timeout = 10_000, message } = {}) {
		const list = (Array.isArray(texts) ? texts : [texts]).map(serialiseText);
		return this.until(({ selector, list }) => {
			const missing = list.filter((t) => !window.__j.byText(selector, t.source !== undefined ? new RegExp(t.source, t.flags) : t));
			return missing.length === 0 || null;
		}, { selector, list }, { timeout, message: message ?? `${list.map((t) => (t.source !== undefined ? `/${t.source}/` : `"${t}"`)).join(", ")} on screen` });
	}

	/** Waits until no element matching `selector` with that text is shown. */
	async gone(text, { selector = "*", timeout = 10_000, message } = {}) {
		const t = serialiseText(text);
		return this.until(({ selector, t }) => !window.__j.byText(selector, t.source !== undefined ? new RegExp(t.source, t.flags) : t), { selector, t }, { timeout, message: message ?? `"${text}" to be gone from the screen` });
	}

	/**
	 * Maps page CSS pixels to screen pixels. A calibration tap is swallowed in the capture phase, so it
	 * reaches nothing in the app; it is repeated whenever the viewport changes (toolbar, keyboard, standalone).
	 */
	async calibrate(page, retry = 0) {
		const known0 = this.calibration.get(page);
		if (!known0 || retry) await this.settle();
		const key = await this.evaluate(page, () => [innerWidth, innerHeight, visualViewport.offsetTop, visualViewport.offsetLeft, visualViewport.scale, matchMedia("(display-mode: standalone)").matches].join("|"));
		if (!retry && known0?.key === key) return known0;
		const sx = this.width / 2;
		const sy = this.height * 0.3;
		// An earlier calibration tap on this document may have arrived after its wait: use it, not another tap.
		let hit = await this.evaluate(page, () => (window.__jCalState && !window.__jCalState.done ? window.__jCalState.point : null)).catch(() => null);
		if (hit) this.log("  the earlier calibration tap reached the page late; using it");
		if (!hit) {
			await this.evaluate(page, () => {
				// Every calibration tap sent to this document is swallowed, including one that arrives late
				// next to its retry: a calibration tap must never reach the app.
				const state = window.__jCalState;
				if (state && !state.done) {
					state.expected += 1;
					return;
				}
				// preventDefault on touchstart suppresses the mouse events and click, so touchend is the last event.
				const types = ["pointerdown", "pointerup", "pointercancel", "touchstart", "touchend", "touchcancel", "mousedown", "mouseup", "click"];
				const fresh = { expected: 1, ended: 0, point: null, done: false };
				window.__jCalState = fresh;
				window.__jCal = new Promise((resolve) => {
					const swallow = (event) => {
						event.preventDefault();
						event.stopImmediatePropagation();
						if (event.type === "touchstart" && !fresh.point) fresh.point = { clientX: event.touches[0].clientX, clientY: event.touches[0].clientY };
						if (event.type === "touchend" || event.type === "touchcancel") {
							fresh.ended += 1;
							resolve(fresh.point);
							if (fresh.ended >= fresh.expected) fresh.finish();
						}
					};
					fresh.finish = () => {
						fresh.done = true;
						types.forEach((type) => removeEventListener(type, swallow, true));
					};
					types.forEach((type) => addEventListener(type, swallow, { capture: true, passive: false }));
				});
			});
			await this.tapScreen(sx, sy);
			hit = await waitFor(() => this.evaluate(page, () => Promise.race([window.__jCal, new Promise((r) => setTimeout(() => r(null), 500))])), {
				timeout: 3_000,
				message: "the calibration tap to reach the page (is native UI covering it?)",
			}).catch(() => null);
		}
		if (!hit && retry >= 2) {
			await this.evaluate(page, () => window.__jCalState?.finish?.()).catch(() => {});
			fail(`the calibration tap did not reach the page; ${await this.diagnoseTouch(sx, sy)}`);
		}
		// A document that replaced the page after the listener went in (a service worker taking over, say)
		// lost it, and the first touch after Chrome starts can be dropped: try again, twice at most.
		if (!hit) {
			await sleep(700);
			return this.calibrate(page, retry + 1);
		}
		// Calibrated: stop swallowing. A tap that was dropped for good must not swallow the app's next touch.
		await this.evaluate(page, () => window.__jCalState?.finish?.()).catch(() => {});
		const dpr = await this.evaluate(page, () => devicePixelRatio);
		const cal = { key, dpr, offX: sx - hit.clientX * dpr, offY: sy - hit.clientY * dpr };
		this.calibration.set(page, cal);
		return cal;
	}

	/** What happens to a tap that does not reach the page: for the failure message. */
	async diagnoseTouch(x, y) {
		const parts = [];
		try {
			const pages = this.pages();
			await Promise.all(pages.map((p) => this.evaluate(p, () => {
				window.__jSeen = [];
				for (const type of ["pointerdown", "touchstart"]) addEventListener(type, () => window.__jSeen.push(type), { capture: true });
			}).catch(() => {})));
			await this.tapScreen(x, y);
			await sleep(800);
			const seen = await Promise.all(pages.map(async (p) => `${p.url()} [${await this.evaluate(p, () => `${document.visibilityState}, ${document.hasFocus() ? "focused" : "unfocused"}, ${window.__jSeen.join("+") || "no touch"}`).catch((e) => e.message.slice(0, 40))}]`));
			parts.push(`pages: ${seen.join("; ")}`);
			parts.push((await this.shell("dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -2")).replace(/\s+/g, " ").trim());
			parts.push(`input: ${(await this.shell("dumpsys input 2>/dev/null | grep -E 'FocusedWindow|FocusedApplication' | head -3")).replace(/\s+/g, " ").trim()}`);
			const at = (await this.nativeNodes()).filter((n) => n.bounds && n.bounds.x1 <= x && x <= n.bounds.x2 && n.bounds.y1 <= y && y <= n.bounds.y2).map((n) => `${n.pkg.split(".").pop()}:${n.id.split("/").pop() || "-"}`);
			parts.push(`at the tap point: ${at.slice(-4).join(" > ") || "nothing"}`);
		} catch (error) {
			parts.push(`(diagnosis failed: ${error.message})`);
		}
		return parts.join(" | ");
	}

	async toScreen(page, x, y) {
		const cal = await this.calibrate(page);
		return { x: cal.offX + x * cal.dpr, y: cal.offY + y * cal.dpr };
	}

	/**
	 * Finds an element in the page (CSS selector, or `{ selector, text }` matched on visible text) and
	 * returns its centre, after checking a person could see and tap it.
	 */
	async locate(target, { timeout = 10_000 } = {}) {
		const page = await this.page();
		const spec = typeof target === "string" ? { selector: target } : target;
		let previous = null;
		let covered = null;
		const box = await waitFor(
			async () => {
				await this.evaluate(page, PAGE_HELPERS);
				const found = await this.evaluate(page, ({ selector, text, index }) => {
					const pattern = text && text.source !== undefined ? new RegExp(text.source, text.flags) : text;
					let el;
					if (pattern !== undefined) el = window.__j.byText(selector ?? "*", pattern);
					else el = [...document.querySelectorAll(selector)].filter(window.__j.visible)[index ?? 0];
					if (!el) return null;
					const r = el.getBoundingClientRect();
					if (r.top < 0 || r.bottom > innerHeight) {
						el.scrollIntoView({ block: "center" });
						return null;
					}
					if (el.disabled || el.closest("[inert]")) return { covered: "(disabled)" };
					if (!window.__j.shown(el)) {
						const c = window.__j.centre(el);
						return { covered: window.__j.describe(document.elementFromPoint(c.x, c.y)) };
					}
					window.__jTarget = el;
					return { ...window.__j.centre(el), width: r.width, height: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
				}, { selector: spec.selector, text: spec.text instanceof RegExp ? { source: spec.text.source, flags: spec.text.flags } : spec.text, index: spec.index });
				if (found?.covered) {
					covered = found.covered;
					return null;
				}
				// Not moving: the same box on two reads in a row (drawers and sheets slide in).
				const key = found && [found.left, found.top, found.width, found.height].map(Math.round).join(",");
				const stable = key && key === previous;
				previous = key;
				return stable ? found : null;
			},
			{ timeout, interval: 120, message: `${describeTarget(spec)} to be on screen, enabled and still` },
		).catch((error) => {
			if (covered) fail(`${describeTarget(spec)} is covered by ${covered}`);
			throw error;
		});
		return { page, box };
	}

	/**
	 * Taps an element with a real touch and checks the touch landed on it. With `effect` (a page
	 * function), waits for it to hold and taps once more if the first touch had no effect.
	 *
	 * A busy page can take a touch, or show its effect, after the wait for it has given up. A second
	 * touch then acts on what the first one did (the drawer's scrim, a menu now covering the target), so
	 * before touching again this looks for the first touch arriving late and for its effect.
	 */
	async tap(target, options = {}) {
		const { effect, arg, effectTimeout = 3_000, ...rest } = options;
		const what = describeTarget(typeof target === "string" ? { selector: target } : target);
		const happened = () => (effect ? this.eval(effect, arg).catch(() => false) : false);
		for (let attempt = 1; ; attempt++) {
			let result;
			try {
				result = await this.tapOnce(target, rest);
			} catch (error) {
				// The second try finding its target covered or gone can be the first touch's work, done late.
				if (attempt >= 2 && effect && (await happened())) {
					this.log(`  the first tap on ${what} took effect late`);
					return null;
				}
				// A touch that never reached the page is worth one more try; then say where it went.
				if (!/never reached the page/.test(error.message)) throw error;
				if (attempt >= 2) fail(`${error.message}; ${await this.diagnoseTouch(this.width / 2, this.height * 0.3)}`);
				const late = await this.lateTouch();
				// It pressed a key instead: the page has changed, and touching again would act on that (#53).
				const typed = await this.eval(() => window.__jTyped ?? null).catch(() => null);
				if (typed) fail(`the tap meant for ${what} never reached the page; it typed "${typed.data}" into ${typed.into} (on-screen keyboard?)`);
				if (late && !late.hit) fail(`the tap meant for ${what} reached the page late and landed on ${late.on}`);
				if (late) {
					this.log(`  the tap on ${what} reached the page late`);
					if (!effect) return null;
				} else if (await happened()) {
					this.log(`  the tap on ${what} took effect without its touch being seen`);
					return null;
				} else {
					this.log("  the tap never reached the page; tapping again");
					continue;
				}
			}
			if (!effect) return result;
			const ok = await waitFor(happened, { timeout: effectTimeout, message: `the tap on ${what} to take effect` }).catch((error) => (attempt >= 2 ? Promise.reject(error) : false));
			if (ok) return result;
			const late = await waitFor(happened, { timeout: 1_500, message: `the tap on ${what} to take effect` }).catch(() => false);
			if (late) {
				this.log(`  the tap on ${what} took effect late, after ${effectTimeout} ms`);
				return result;
			}
			this.log(`  the tap on ${what} had no effect; tapping again`);
		}
	}

	/** After a tap that seemed not to reach the page: whether it arrived since (tapOnce's listener saw it), waiting a moment. */
	async lateTouch() {
		await sleep(1_500);
		const page = await this.page().catch(() => null);
		return page ? this.evaluate(page, () => window.__jTap ?? null).catch(() => null) : null;
	}

	async tapOnce(target, options = {}) {
		const what = describeTarget(typeof target === "string" ? { selector: target } : target);
		// The keyboard is on screen before Chrome shrinks the page for it (a second or more on a busy
		// device), and a touch on the page's old layout then presses a key instead (#53): wait for the page.
		let page, box, point;
		const deadline = Date.now() + 8_000;
		for (let waited = false; ; waited = true) {
			({ page, box } = await this.locate(target, options));
			point = await this.toScreen(page, box.x, box.y);
			if (!inRegion(await this.keyboardRegion(), point.x, point.y)) break;
			if (Date.now() > deadline) fail(`${what} is covered by the on-screen keyboard`);
			if (!waited) this.log(`  ${what} is under the on-screen keyboard; waiting for the page to make room`);
			await sleep(250);
		}
		await this.evaluate(page, () => {
			window.__jTap = null;
			addEventListener("pointerdown", (event) => {
				window.__jTap = { hit: window.__jTarget?.contains(event.target) || event.target.contains?.(window.__jTarget), on: window.__j.describe(event.target) };
			}, { capture: true, once: true });
			// A touch the page never sees can still type into it, through the keyboard it landed on.
			window.__jTypedOff?.();
			window.__jTyped = null;
			const typed = (event) => {
				window.__jTyped ??= { data: event.data ?? event.inputType, into: window.__j.describe(event.target) };
			};
			addEventListener("beforeinput", typed, { capture: true });
			window.__jTypedOff = () => removeEventListener("beforeinput", typed, { capture: true });
		});
		await this.tapScreen(point.x, point.y);
		// The touch arrives a moment after `input tap` returns; a navigation it starts ends the check.
		let landed;
		for (let i = 0; i < 15 && !landed; i++) {
			landed = await this.evaluate(page, () => window.__jTap).catch(() => undefined);
			if (landed === undefined) break;
			if (!landed) await sleep(100);
		}
		if (landed === null) fail(`the tap meant for ${what} never reached the page (native UI covering it?)`);
		if (landed && !landed.hit) fail(`the tap meant for ${what} landed on ${landed.on}`);
		return { page, box, point };
	}

	/** Taps a text field and waits for it to take focus, tapping once more if the first touch did not focus it. */
	async focus(selector) {
		await this.tap(selector, { effect: (sel) => document.activeElement === document.querySelector(sel) || !!document.querySelector(sel)?.contains(document.activeElement), arg: selector, effectTimeout: 3_000 });
	}

	/**
	 * Focuses a field, types `text` and checks the field holds it. `input text` can drop a character
	 * under load; then the field is emptied with Delete key presses and typed once more.
	 */
	async typeInto(selector, text, { append = false } = {}) {
		const read = (sel) => {
			const el = document.querySelector(sel);
			return el.isContentEditable ? el.innerText.replace(/\s+/g, " ").trim() : el.value;
		};
		const before = append ? await this.eval(read, selector) : "";
		for (let attempt = 1; ; attempt++) {
			const focused = await this.eval((sel) => document.activeElement === document.querySelector(sel), selector);
			if (!focused) await this.focus(selector);
			await this.type(text);
			const expected = before + text;
			const ok = await waitFor(async () => (await this.eval(read, selector)) === expected, { timeout: 4_000, message: `${selector} to hold the typed text` }).catch((error) => (attempt >= 2 ? Promise.reject(error) : false));
			if (ok) return;
			const now = await this.eval(read, selector);
			// The last characters can land just after the wait: never clear text that is complete.
			if (now === expected) return;
			const length = now.length;
			this.log(`  ${selector} did not get all of the text; clearing and typing it again`);
			await this.shell(`input keyevent 123 ${"67 ".repeat(Math.max(0, length - before.length) + 2)}`);
		}
	}

	/** Swipes across an element horizontally or vertically (fractions of its box), with a real touch. */
	async swipe(target, { from = [0.9, 0.5], to = [0.1, 0.5], ms = 300, screenEdge = false } = {}) {
		const { page, box } = await this.locate(target);
		const w = box.right - box.left;
		const h = box.bottom - box.top;
		const a = await this.toScreen(page, box.left + w * from[0], box.top + h * from[1]);
		const b = await this.toScreen(page, box.left + w * to[0], box.top + h * to[1]);
		if (screenEdge) {
			// "From the edge of the screen", but outside the system Back gesture zone along each side.
			const inset = Math.round(this.width * 0.075);
			a.x = Math.min(Math.max(a.x, inset), this.width - inset);
			b.x = Math.min(Math.max(b.x, inset), this.width - inset);
		}
		await this.swipeScreen(a.x, a.y, b.x, b.y, ms);
	}

	async goto(url) {
		const page = await this.page().catch(() => null);
		if (page) {
			await page.goto(url, { waitUntil: "load" });
		} else {
			await this.shell(`am start -a android.intent.action.VIEW -d '${url}' com.android.chrome`);
		}
		return this.page();
	}

	/** Signs in through the API, as setup for journeys that start signed in. */
	async signIn() {
		let page = await this.page().catch(() => null);
		if (!page) page = await this.goto(BLANK);
		const status = await this.evaluate(page, async (login) => (await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(login) })).status, LOGIN);
		if (status !== 200) fail(`sign-in for setup answered ${status}`);
	}

	async signOut() {
		const page = await this.page();
		await this.evaluate(page, () => fetch("/api/auth/logout", { method: "POST" }).catch(() => {}));
		await page.context().clearCookies();
	}

	/** Signed in, online, on `path` (default the v2 inbox) with at least `rows` conversations in the inbox. */
	async startSignedIn({ path = "/v2/inbox", rows = 1 } = {}) {
		await this.goto(BLANK);
		await this.signIn();
		let page = await this.goto(`${APP}/v2/inbox`);
		const count = await this.evaluate(page, () => document.querySelectorAll("li[data-row]").length);
		if (count < rows) {
			await this.deliverMail(rows - count);
			// Delivery goes through the inbound queue: wait until the list has the new mail.
			await waitFor(async () => {
				page = await this.goto(`${APP}/v2/inbox`);
				return (await this.evaluate(page, () => document.querySelectorAll("li[data-row]").length)) >= rows;
			}, { timeout: 30_000, interval: 1_000, message: `${rows} conversations in the inbox after delivering mail` });
		}
		if (path !== "/v2/inbox") await this.goto(`${APP}${path}`);
		await this.until(() => document.readyState === "complete" && !!document.querySelector("#main"), null, { message: `${path} to load` });
	}

	/**
	 * A service worker registered by an earlier visit, as the offline journeys start: once it is active,
	 * load the page again through it (a page loaded before the worker took control is never stored) and
	 * wait for the stored copy.
	 */
	async ensureServiceWorker() {
		let page = await this.page();
		await this.evaluate(page, () => navigator.serviceWorker.ready.then(() => true), undefined, { timeout: 30_000 });
		await page.reload({ waitUntil: "load" });
		page = await this.page();
		await this.until(async () => {
			if (!navigator.serviceWorker.controller) return false;
			for (const name of await caches.keys()) {
				if (name.startsWith("mf-user-") && (await (await caches.open(name)).match(location.href, { ignoreVary: true }))) return true;
			}
			return false;
		}, null, { message: "the service worker to control the page and store it" });
	}

	/** The v2 drawer: open when the body says so and the folder list is on screen. */
	async drawerOpen() {
		return this.eval(DRAWER_OPEN);
	}

	/**
	 * Taps the menu button and waits for the drawer; one more tap if the first touch was dropped (as after
	 * Quick Settings closes), but only once the drawer has had time to open late: a second tap on an open
	 * drawer lands on its scrim.
	 */
	async openDrawer() {
		await this.tap("[data-nav-toggle]", { effect: DRAWER_OPEN, effectTimeout: 2_500 });
	}

	/** Waits until the page has stopped changing: the same document, fully loaded, no htmx request in flight. */
	async settle({ timeout = 15_000 } = {}) {
		let last = null;
		await waitFor(async () => {
			const now = await this.eval(() => {
				window.__jDoc ??= Math.random().toString(36).slice(2);
				return document.readyState === "complete" && !document.querySelector(".htmx-request") ? `${window.__jDoc} ${location.href}` : null;
			}).catch(() => null);
			const stable = now !== null && now === last;
			last = now;
			if (!stable) await sleep(400);
			return stable;
		}, { timeout, interval: 0, message: "the page to settle" });
	}

	/** Opens the drawer, taps a folder in it and waits for that page. */
	async drawerTo(label) {
		await this.openDrawer();
		await this.tap({ selector: "#nav .nav-label", text: label });
		await this.settle();
	}

	/** Delivers mail through the Worker's email handler on the host, as the README does with curl. */
	async deliverMail(count, prefix = "Journey mail") {
		for (let i = 1; i <= count; i++) {
			const id = `journey-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}@journeys.test`;
			const raw = [`From: Journey Sender ${i} <sender${i}@journeys.test>`, "To: support@example.com", `Subject: ${prefix} ${i}`, `Message-ID: <${id}>`, `Date: ${new Date().toUTCString()}`, "Content-Type: text/plain; charset=utf-8", "", `Hello from the journey run, message ${i}.`, ""].join("\r\n");
			const res = await fetch(`http://127.0.0.1:${this.hostPort}/cdn-cgi/handler/email?from=sender${i}@journeys.test&to=support@example.com`, { method: "POST", body: raw });
			if (!res.ok) throw new Error(`mail delivery answered ${res.status}`);
		}
	}
}

function serialiseText(text) {
	return text instanceof RegExp ? { source: text.source, flags: text.flags } : text;
}

function describeTarget(spec) {
	if (spec.text !== undefined) return `"${spec.text}"${spec.selector ? ` (${spec.selector})` : ""}`;
	return spec.selector + (spec.index ? `[${spec.index}]` : "");
}

function decodeXml(value) {
	return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
