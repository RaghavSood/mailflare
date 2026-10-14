// Pure helpers for the journey runner: reading journey XML, sharding, deciding the outcome, writing results.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(value) {
	return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]).replace(/\s+/g, " ").trim();
}

function encode(value) {
	return String(value).replace(/[&<>"']/g, (c) => `&${Object.keys(ENTITIES).find((k) => ENTITIES[k] === c)};`);
}

/** The journey's name, description and actions, in order, as written in its XML. */
export function parseJourney(id, xml) {
	const name = xml.match(/<journey\s+name="([^"]*)"/)?.[1];
	if (!name) throw new Error(`${id}: no <journey name="…">`);
	const description = xml.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "";
	const actions = [...xml.matchAll(/<action>([\s\S]*?)<\/action>/g)].map((m) => decode(m[1]));
	if (actions.length === 0) throw new Error(`${id}: no <action>s`);
	return { id, name: decode(name), description: decode(description), actions };
}

/** Shard "k/n" (1-based) of the list, dealt round-robin so the slow offline journeys spread out. */
export function shardOf(items, spec) {
	const match = /^(\d+)\/(\d+)$/.exec(spec);
	if (!match) throw new Error(`--shard must look like 1/3, got ${spec}`);
	const [k, n] = [Number(match[1]), Number(match[2])];
	if (k < 1 || k > n) throw new Error(`--shard ${spec} is out of range`);
	return items.filter((_, i) => i % n === k - 1);
}

/**
 * What a journey's result counts as. "failed" covers a real failure and a known issue that no longer
 * reproduces (both set `error`); "known" is a pass whose one excused action failed as expected.
 */
export function outcome(result) {
	if (result.unscripted) return "unscripted";
	if (result.error) return "failed";
	return result.steps.some((s) => s.status === "known") ? "known" : "passed";
}

/** Whether the run fails: any real failure, or an unscripted journey unless that is allowed. */
export function runFails(results, { allowUnscripted = false } = {}) {
	return results.some((r) => outcome(r) === "failed" || (outcome(r) === "unscripted" && !allowUnscripted));
}

const STEP_ICON = { passed: "✅", failed: "❌", xpass: "❌", known: "⚠️", skipped: "⏭️", unscripted: "🚧" };
const RESULT_ICON = { passed: "✅", failed: "❌", known: "⚠️", unscripted: "🚧" };

export function markdownSummary(results, meta = {}) {
	const lines = [];
	const count = (o) => results.filter((r) => outcome(r) === o).length;
	const passed = count("passed") + count("known");
	lines.push(`## Journeys${meta.shard && meta.shard !== "all" ? ` (shard ${meta.shard})` : ""}: ${passed}/${results.length} passed${count("known") ? ` (${count("known")} with a known issue)` : ""}${count("unscripted") ? `, ${count("unscripted")} not scripted` : ""}`);
	lines.push("");
	if (meta.chrome || meta.sdk) lines.push(`Android SDK ${meta.sdk ?? "?"}, Chrome ${meta.chrome ?? "?"}, ${Math.round((meta.durationMs ?? 0) / 1000)} s.`, "");
	lines.push("| Journey | Result |", "|---|---|");
	for (const r of results) {
		const o = outcome(r);
		const failedAt = r.steps.findIndex((s) => s.status === "failed" || s.status === "xpass");
		const knownAt = r.steps.findIndex((s) => s.status === "known");
		const detail = {
			unscripted: "🚧 not scripted yet",
			failed: `❌ action ${failedAt + 1}: ${oneLine(r.error ?? "")}`,
			known: `⚠️ action ${knownAt + 1} fails as expected: ${r.knownIssue?.issue}`,
			passed: "✅",
		}[o];
		lines.push(`| ${r.id} | ${detail.replace(/\|/g, "\\|")} |`);
	}
	for (const r of results) {
		lines.push("", `### ${r.id}: ${r.name} ${RESULT_ICON[outcome(r)]} (${Math.round((r.durationMs ?? 0) / 100) / 10} s)`, "");
		r.steps.forEach((s, i) => {
			lines.push(`${i + 1}. ${STEP_ICON[s.status]} ${s.label}`);
			if (s.status === "known") lines.push(`   - Known issue: ${r.knownIssue?.issue}`);
			if (s.error) lines.push(`   - ${oneLine(s.error)}`);
			if (s.screenshot) lines.push(`   - Screenshot: \`${s.screenshot}\``);
		});
	}
	return `${lines.join("\n")}\n`;
}

export function junitXml(results, meta = {}) {
	const isFailure = (s) => s.status === "failed" || s.status === "xpass";
	const isSkipped = (s) => s.status === "skipped" || s.status === "unscripted" || s.status === "known";
	const cases = results.flatMap((r) => r.steps.map((s, i) => ({ r, s, i })));
	const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuites name="journeys${meta.shard && meta.shard !== "all" ? ` ${encode(meta.shard)}` : ""}" tests="${cases.length}" failures="${cases.filter(({ s }) => isFailure(s)).length}" skipped="${cases.filter(({ s }) => isSkipped(s)).length}" time="${((meta.durationMs ?? 0) / 1000).toFixed(1)}">`];
	for (const r of results) {
		out.push(`\t<testsuite name="${encode(`${r.id}: ${r.name}`)}" tests="${r.steps.length}" failures="${r.steps.filter(isFailure).length}" skipped="${r.steps.filter(isSkipped).length}" time="${((r.durationMs ?? 0) / 1000).toFixed(1)}">`);
		r.steps.forEach((s, i) => {
			const open = `\t\t<testcase classname="${encode(r.id)}" name="${encode(`${String(i + 1).padStart(2, "0")}. ${s.label}`)}" time="${((s.durationMs ?? 0) / 1000).toFixed(1)}"`;
			const detail = encode(`${s.error ?? ""}${s.screenshot ? `\nScreenshot: ${s.screenshot}` : ""}`);
			if (s.status === "passed") out.push(`${open}/>`);
			else if (isFailure(s)) out.push(`${open}><failure message="${encode(oneLine(s.error ?? "failed"))}">${detail}</failure></testcase>`);
			else {
				const why = { known: `known issue: ${r.knownIssue?.issue}`, unscripted: "not scripted yet", skipped: "an earlier action failed" }[s.status];
				out.push(`${open}><skipped message="${encode(why)}">${detail}</skipped></testcase>`);
			}
		});
		out.push("\t</testsuite>");
	}
	out.push("</testsuites>");
	return `${out.join("\n")}\n`;
}

function oneLine(text) {
	const first = String(text).split("\n")[0];
	return first.length > 300 ? `${first.slice(0, 297)}…` : first;
}
