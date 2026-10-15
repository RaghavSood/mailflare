import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { displayOverrides, junitXml, markdownSummary, outcome, parseJourney, runFails, shardOf } from "../journeys/run/report-utils.mjs";

const journeysDir = join(dirname(fileURLToPath(import.meta.url)), "..", "journeys");
const journeys = readdirSync(journeysDir)
	.filter((name) => name.endsWith(".journey.xml"))
	.sort()
	.map((name) => parseJourney(name.replace(/\.journey\.xml$/, ""), readFileSync(join(journeysDir, name), "utf8")));

test("every journey has a script whose steps are its actions, in order", async () => {
	assert.ok(journeys.length > 0);
	for (const journey of journeys) {
		const script = (await import(pathToFileURL(join(journeysDir, "run", `${journey.id}.mjs`)))).default;
		assert.deepEqual(script.steps.map(([label]) => label), journey.actions, `${journey.id}: steps differ from the XML actions`);
		if (script.knownIssue) assert.ok(journey.actions.includes(script.knownIssue.step), `${journey.id}: knownIssue.step is not an action`);
	}
});

test("parseJourney decodes entities and collapses whitespace", () => {
	const j = parseJourney("x", `<journey name="A &amp; B"><description>d</description><actions><action>Tap "Sent"\n\t\tnow</action><action>Verify it&apos;s &lt;on&gt;</action></actions></journey>`);
	assert.equal(j.name, "A & B");
	assert.deepEqual(j.actions, ['Tap "Sent" now', "Verify it's <on>"]);
});

test("shards are dealt round-robin and cover every journey once", () => {
	const items = [1, 2, 3, 4, 5, 6, 7];
	assert.deepEqual(shardOf(items, "1/3"), [1, 4, 7]);
	assert.deepEqual(shardOf(items, "3/3"), [3, 6]);
	assert.deepEqual([1, 2, 3].flatMap((k) => shardOf(items, `${k}/3`)).sort(), items);
	assert.throws(() => shardOf(items, "4/3"));
});

const step = (status, extra = {}) => ({ label: `step ${status}`, status, ...extra });

test("only a real failure, a fixed known issue or (outside drafts) an unscripted journey fails the run", () => {
	const passed = { id: "a", steps: [step("passed")] };
	const known = { id: "b", knownIssue: { step: "step known", issue: "#19" }, steps: [step("passed"), step("known", { error: "x" })] };
	const failed = { id: "c", error: "boom", steps: [step("failed", { error: "boom" })] };
	const xpass = { id: "d", error: "no longer reproduces", knownIssue: { step: "step xpass", issue: "#20" }, steps: [step("xpass", { error: "no longer reproduces" })] };
	const unscripted = { id: "e", unscripted: true, steps: [step("unscripted")] };
	assert.deepEqual([passed, known, failed, xpass, unscripted].map(outcome), ["passed", "known", "failed", "failed", "unscripted"]);
	assert.equal(runFails([passed, known]), false);
	assert.equal(runFails([passed, failed]), true);
	assert.equal(runFails([known, xpass]), true);
	assert.equal(runFails([passed, unscripted]), true);
	assert.equal(runFails([passed, unscripted], { allowUnscripted: true }), false);

	const md = markdownSummary([passed, known, failed], { shard: "1/3" });
	assert.match(md, /2\/3 passed \(1 with a known issue\)/);
	assert.match(md, /\| b \| ⚠️ action 2 fails as expected: #19 \|/);
	assert.match(md, /\| c \| ❌ action 1: boom \|/);
	const xml = junitXml([passed, known, failed]);
	assert.match(xml, /tests="4" failures="1" skipped="1"/);
	assert.match(xml, /<skipped message="known issue: #19">/);
});

test("a display override left by an interrupted journey is recognised, and only an override", () => {
	// What `wm size` and `wm density` print on the CI image, with and without an override (journey 17 sets one).
	const size = "Physical size: 1080x2400\nOverride size: 1280x800\n";
	const density = "Physical density: 420\r\nOverride density: 200\r\n";
	assert.deepEqual(displayOverrides(size, density), ["size 1280x800 (physical 1080x2400)", "density 200 (physical 420)"]);
	assert.deepEqual(displayOverrides("Physical size: 1080x2400\n", density), ["density 200 (physical 420)"]);
	assert.deepEqual(displayOverrides("Physical size: 1080x2400\n", "Physical density: 420\n"), []);
	assert.deepEqual(displayOverrides("", undefined), [], "no output (adb failed) is not an override");
});

test("run warnings are shown above the results, and only when there are some", () => {
	const passed = { id: "01-a", name: "A", steps: [{ label: "Do it", status: "passed" }], durationMs: 1000 };
	const warned = markdownSummary([passed], { warnings: ["The display was overridden (size 1280x800) before 01-a, left by an interrupted journey; it was reset."] });
	assert.match(warned, /\n> \[!WARNING\]\n> The display was overridden \(size 1280x800\) before 01-a, .*\n\n\| Journey \| Result \|/);
	assert.doesNotMatch(markdownSummary([passed], { warnings: [] }), /WARNING/);
	assert.doesNotMatch(markdownSummary([passed]), /WARNING/);
});

test("a failed action names its Android crash log when there is one", () => {
	const failed = { id: "20-a", name: "A", error: "x", steps: [{ label: "Do it", status: "failed", error: "x", screenshot: "screens/20-a-1.png", crashLog: "screens/20-a-1-crash.txt" }], durationMs: 1000 };
	assert.match(markdownSummary([failed]), /- Screenshot: `screens\/20-a-1\.png`\n {3}- Android crash log: `screens\/20-a-1-crash\.txt`/);
});

test("a DevTools call that never answers fails after its deadline and drops the connection", async () => {
	const { Device } = await import("../journeys/run/harness.mjs");
	const device = new Device({});
	device.browser = { stale: true };
	device.shell = async () => "  mCurrentFocus=Window{1a2b u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}";
	const hung = { evaluate: () => new Promise(() => {}) };
	await assert.rejects(device.evaluate(hung, () => 1, undefined, { timeout: 50 }), /did not answer within 0\.05 s \(in front: com\.google\.android\.apps\.nexuslauncher\/com\.google\.android\.apps\.nexuslauncher\.NexusLauncherActivity\)/);
	assert.equal(device.browser, null, "the next lookup connects afresh");

	device.browser = { live: true };
	assert.equal(await device.evaluate({ evaluate: async (fn, arg) => fn(arg) }, (n) => n + 1, 1), 2);
	await assert.rejects(device.evaluate({ evaluate: async () => { throw new Error("Execution context was destroyed"); } }, () => 1), /context was destroyed/, "other errors pass through");
	assert.deepEqual(device.browser, { live: true }, "and keep the connection");
});
