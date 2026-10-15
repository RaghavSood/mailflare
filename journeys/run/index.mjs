#!/usr/bin/env node
// Runs the scripted journeys against an Android emulator or device. See ../README.md.
//
//   node journeys/run/index.mjs [--shard 1/3] [--out dir] [--keep-chrome-data] [--allow-unscripted] [01 05 ...]
//
// Environment: ANDROID_SERIAL (which device), MAILFLARE_HOST_PORT (the host port the server listens on,
// default 3000; the device's localhost:3000 reaches it through the runner's relay), CDP_PORT (host port for Chrome DevTools, default 9222).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BLANK, Device, StepError, sleep } from "./harness.mjs";
import { junitXml, markdownSummary, outcome, parseJourney, runFails, shardOf } from "./report-utils.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const journeysDir = join(here, "..");

const args = process.argv.slice(2);
const option = (name) => {
	const i = args.indexOf(name);
	if (i < 0) return undefined;
	const [value] = args.splice(i, 2).slice(1);
	return value;
};
const flag = (name) => {
	const i = args.indexOf(name);
	if (i >= 0) args.splice(i, 1);
	return i >= 0;
};
const shard = option("--shard");
const out = option("--out") ?? join(journeysDir, "..", "journey-results");
const keepChromeData = flag("--keep-chrome-data");
// Journeys without a script fail the run unless this is given (CI passes it only for draft pull requests).
const allowUnscripted = flag("--allow-unscripted");
const only = args;

// A step may ask for longer as a third entry, [label, run, { timeout }] (a wait on something outside the device, such as a push service).
// A script may ask for a longer setup with `setupTimeout` (one that restarts Chrome on a cleared profile).
const STEP_TIMEOUT = 60_000;
const SETUP_TIMEOUT = 90_000;
const JOURNEY_TIMEOUT = 8 * 60_000;

const all = readdirSync(journeysDir)
	.filter((name) => name.endsWith(".journey.xml"))
	.sort()
	.map((name) => ({ id: name.replace(/\.journey\.xml$/, ""), xml: readFileSync(join(journeysDir, name), "utf8") }));
let selected = all.filter((j) => only.length === 0 || only.some((o) => j.id.startsWith(o)));
if (shard) selected = shardOf(selected, shard);

mkdirSync(join(out, "screens"), { recursive: true });
const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);

const device = new Device({
	serial: process.env.ANDROID_SERIAL,
	hostPort: Number(process.env.MAILFLARE_HOST_PORT ?? 3000),
	cdpPort: Number(process.env.CDP_PORT ?? 9222),
	log,
});

async function withTimeout(promise, ms, what) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new StepError(`${what} did not finish within ${ms / 1000} s`)), ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

/** Run-level warnings for the summary (the display found overridden). */
const warnings = [];

/** The display as the device has it: an override left by an interrupted journey is reset and reported. */
async function ensureOwnDisplay(before) {
	const overrides = await device.resetDisplay();
	if (!overrides.length) return;
	const warning = `The display was overridden (${overrides.join(", ")}) ${before}, left by an interrupted journey; it was reset.`;
	warnings.push(warning);
	log(`  ⚠️ ${warning}`);
}

async function prepareDevice() {
	await device.open();
	await ensureOwnDisplay("when the run started");
	log(`device ${device.serial} ${device.width}x${device.height}, server on host port ${device.hostPort}`);
	const res = await fetch(`http://127.0.0.1:${device.hostPort}/login`).catch((error) => ({ ok: false, status: error.message }));
	if (!res.ok) throw new Error(`The server on host port ${device.hostPort} is not answering /login (${res.status}). Start it as journeys/README.md describes.`);

	await device.shell("settings put global hide_error_dialogs 1");
	await device.setOffline(false);
	await device.startChrome({ fresh: !keepChromeData });
	// Touches have been seen not to reach Chrome for a while right after the emulator boots: wait until
	// one does (on a static page, where a swallowed tap changes nothing) before any journey starts.
	const warm = Date.now();
	for (let attempt = 1; ; attempt++) {
		const ok = await device.calibrate(await device.page()).then(() => true, (error) => {
			log(`  touch warm-up ${attempt}: ${error.message}`);
			return false;
		});
		if (ok) break;
		if (Date.now() - warm > 45_000) throw new Error("touches on the screen never reached Chrome");
		await sleep(2_000);
	}
	log(`touch input reaches Chrome (${Math.round((Date.now() - warm) / 100) / 10} s)`);
	const chrome = (await device.shell("dumpsys package com.android.chrome 2>/dev/null | grep -m1 versionName")).trim();
	const sdk = (await device.shell("getprop ro.build.version.sdk")).trim();
	return { chrome: chrome.replace("versionName=", ""), sdk };
}

/** The server answers on the host port (waits a while: a restarted wrangler dev takes a few seconds). */
async function serverUp(timeout = 60_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const res = await fetch(`http://127.0.0.1:${device.hostPort}/login`).catch(() => null);
		if (res?.ok) return true;
		await sleep(1_000);
	}
	return false;
}

/**
 * "Online" means a network, not just Airplane mode off: after a journey turns Airplane mode off, Wi-Fi
 * and mobile data take a few seconds to come back, and push subscription (10) needs them.
 */
async function networkUp(timeout = 30_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const active = await device.shell("dumpsys connectivity 2>/dev/null | grep -m1 'Active default network'").catch(() => "");
		if (/Active default network: \d+/.test(active)) return;
		await sleep(1_000);
	}
	log("  the device has no network after 30 s");
}

/** Chrome's own tab activity in front (not the installed web app, the launcher or a dialog), with DevTools attached. */
async function chromeInFront() {
	await device.shell("cmd statusbar collapse");
	const focus = await device.shell("dumpsys window 2>/dev/null | grep -m1 mCurrentFocus");
	if (/ChromeTabbedActivity/.test(focus) && device.browser) return;
	log(`  resetting Chrome (in front: ${focus.trim().replace(/^.*\{[^ ]+ u0 /, "").replace(/\}$/, "") || "nothing"})`);
	await device.shell("am force-stop com.android.chrome");
	await device.shell(`am start -a android.intent.action.VIEW -d '${BLANK}' com.android.chrome`);
	device.browser = null;
	await device.page({ timeout: 30_000 });
	await device.singleTab();
	// Touches have been seen not to reach Chrome for a while right after the emulator boots: wait until
	// one does (on a static page, where a swallowed tap changes nothing) before any journey starts.
	const warm = Date.now();
	for (let attempt = 1; ; attempt++) {
		const ok = await device.calibrate(await device.page()).then(() => true, (error) => {
			log(`  touch warm-up ${attempt}: ${error.message}`);
			return false;
		});
		if (ok) break;
		if (Date.now() - warm > 45_000) throw new Error("touches on the screen never reached Chrome");
		await sleep(2_000);
	}
	log(`touch input reaches Chrome (${Math.round((Date.now() - warm) / 100) / 10} s)`);
}

async function runJourney(journey) {
	const result = { id: journey.id, name: journey.name, steps: journey.actions.map((label) => ({ label, status: "skipped" })), error: null, durationMs: 0 };
	const file = join(here, `${journey.id}.mjs`);
	if (!existsSync(file)) {
		result.unscripted = true;
		result.steps.forEach((step) => (step.status = "unscripted"));
		return result;
	}
	const script = (await import(pathToFileURL(file))).default;
	// A known issue excuses exactly one action: that action failing is expected, it passing is a failure
	// (the issue is fixed, so the marker must go), and any other failure in the journey still fails it.
	const known = script.knownIssue ?? null;
	result.knownIssue = known;
	if (known && !journey.actions.includes(known.step)) {
		result.error = `journeys/run/${journey.id}.mjs: knownIssue.step is not one of the journey's actions ("${known.step}")`;
		Object.assign(result.steps[0], { status: "failed", error: result.error });
		return result;
	}
	const labels = script.steps.map(([label]) => label);
	const mismatch = journey.actions.findIndex((action, i) => labels[i] !== action);
	if (mismatch >= 0 || labels.length !== journey.actions.length) {
		const at = mismatch >= 0 ? mismatch : Math.min(labels.length, journey.actions.length);
		result.error = `journeys/run/${journey.id}.mjs is out of step with the XML at action ${at + 1}: XML "${journey.actions[at] ?? "(none)"}", script "${labels[at] ?? "(none)"}"`;
		result.steps[Math.min(at, result.steps.length - 1)].status = "failed";
		result.steps[Math.min(at, result.steps.length - 1)].error = result.error;
		return result;
	}

	const started = Date.now();
	const ctx = { device, log, state: {} };
	log(`▶ ${journey.id}`);
	try {
		// Nothing left over from the journey before: the server up, no Quick Settings, a Chrome tab in front.
		if (!(await serverUp())) throw new Error(`the server on host port ${device.hostPort} is not answering /login (see wrangler.log)`);
		await ensureOwnDisplay(`before ${journey.id}`);
		await networkUp();
		await chromeInFront();
		if (script.setup) {
			try {
				await withTimeout(script.setup(ctx), script.setupTimeout ?? SETUP_TIMEOUT, "setup");
			} catch (error) {
				// Setup is not a journey action: if it failed because the server went away (wrangler dev
				// restarting, see journeys/ci/server.sh), wait for it and set up once more.
				log(`  setup failed (${error.message.split("\n")[0]}); waiting for the server and setting up again`);
				if (!(await serverUp())) throw error;
				await chromeInFront();
				await withTimeout(script.setup(ctx), script.setupTimeout ?? SETUP_TIMEOUT, "setup");
			}
		}
	} catch (error) {
		result.error = `setup: ${error.message}`;
		log(`  ❌ setup: ${error instanceof TypeError || error instanceof ReferenceError ? error.stack : error.message}`);
		result.steps[0].status = "failed";
		result.steps[0].error = result.error;
		await capture(journey.id, "setup", result.steps[0]);
	}
	let stopped = false;
	for (const [i, [label, run, options]] of script.steps.entries()) {
		if (result.error || stopped) break;
		const step = result.steps[i];
		const t = Date.now();
		try {
			await withTimeout(run(ctx), options?.timeout ?? STEP_TIMEOUT, "the step");
			step.status = "passed";
			step.durationMs = Date.now() - t;
			log(`  ✅ ${label} (${step.durationMs} ms)`);
		} catch (error) {
			step.durationMs = Date.now() - t;
			// A script bug keeps its stack; anything else is a finding about the app, and its message says what.
			const scriptBug = error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError;
			step.error = scriptBug ? error.stack : error?.message ?? String(error);
			if (known && label === known.step && !scriptBug) {
				step.status = "known";
				stopped = true;
				log(`  ⚠️ ${label}\n     fails as expected (${known.issue}): ${step.error.split("\n")[0]}`);
			} else {
				step.status = "failed";
				result.error = step.error;
				log(`  ❌ ${label}\n     ${step.error.split("\n")[0]}`);
			}
			await capture(journey.id, i + 1, step);
		}
	}
	const knownStep = known && result.steps.find((step) => step.label === known.step);
	if (knownStep?.status === "passed") {
		knownStep.status = "xpass";
		knownStep.error = `known issue no longer reproduces (${known.issue}): remove knownIssue from journeys/run/${journey.id}.mjs`;
		result.error = knownStep.error;
		log(`  ❌ ${knownStep.error}`);
	}
	try {
		if (script.teardown) await withTimeout(script.teardown(ctx), SETUP_TIMEOUT, "teardown");
	} catch (error) {
		log(`  teardown: ${error.message}`);
	}
	// Whatever happened, the next journey starts online with Chrome in front.
	await device.setOffline(false).catch(() => {});
	result.durationMs = Date.now() - started;
	return result;
}

async function capture(id, step, into) {
	const file = `screens/${id}-${step}.png`;
	try {
		await device.screenshot(join(out, file));
		into.screenshot = file;
	} catch (error) {
		log(`  (screenshot failed: ${error.message})`);
	}
	// Whether an app crashed (Chrome leaving the screen mid-step, say): Android's crash log, if it has anything.
	try {
		const crashes = (await device.shell("logcat -d -b crash 2>/dev/null | tail -200")).trim();
		if (crashes) {
			writeFileSync(join(out, `screens/${id}-${step}-crash.txt`), `${crashes}\n`);
			into.crashLog = `screens/${id}-${step}-crash.txt`;
		}
	} catch {
		/* no crash log to add */
	}
}

const started = Date.now();
let env = {};
const results = [];
try {
	env = await prepareDevice();
	log(`Chrome ${env.chrome}, Android SDK ${env.sdk}; running ${selected.map((j) => j.id.slice(0, 2)).join(" ")}`);
	for (const file of selected) {
		const journey = parseJourney(file.id, file.xml);
		// A journey that wedges (say, an unanswered DevTools call) fails on its own instead of stalling the shard.
		results.push(await withTimeout(runJourney(journey), JOURNEY_TIMEOUT, `journey ${journey.id}`).catch((error) => {
			log(`  ❌ ${error.message}`);
			return { id: journey.id, name: journey.name, steps: journey.actions.map((label, i) => ({ label, status: i === 0 ? "failed" : "skipped", error: i === 0 ? error.message : undefined })), error: error.message, durationMs: JOURNEY_TIMEOUT };
		}));
		await device.setOffline(false).catch(() => {});
		await sleep(250);
	}
} catch (error) {
	console.error(error);
	results.push({ id: "setup", name: "Device and server setup", steps: [{ label: "Prepare the device", status: "failed", error: error.message }], error: error.message, durationMs: 0 });
}

const meta = { shard: shard ?? "all", chrome: env.chrome, sdk: env.sdk, durationMs: Date.now() - started, warnings };
writeFileSync(join(out, `junit${shard ? `-${shard.replace("/", "of")}` : ""}.xml`), junitXml(results, meta));
writeFileSync(join(out, `summary${shard ? `-${shard.replace("/", "of")}` : ""}.md`), markdownSummary(results, meta));
const counts = Object.groupBy(results, outcome);
for (const [name, list] of Object.entries(counts)) if (name !== "passed") log(`${name}: ${list.map((r) => r.id).join(", ")}`);
const fails = runFails(results, { allowUnscripted });
log(`${(counts.passed?.length ?? 0) + (counts.known?.length ?? 0)}/${results.length} journeys passed in ${Math.round(meta.durationMs / 1000)} s; results in ${out}${fails ? "" : " (run passes)"}`);
process.exit(fails ? 1 : 0);
