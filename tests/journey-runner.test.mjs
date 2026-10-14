import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { junitXml, markdownSummary, outcome, parseJourney, runFails, shardOf } from "../journeys/run/report-utils.mjs";

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
