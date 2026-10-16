/**
 * End-to-end check of API key authentication on the JMAP and /api/v1 surfaces
 * against a running server, plus a small timing bench: Basic and Bearer auth,
 * the four-call read bundle, Identity/get, blob upload and download, the event
 * source, CORS preflight, autodiscovery, and that a revoked key stops working
 * on the very next request.
 *
 *   npm run dev && npm run db:seed        # in another shell (or wrangler dev on a build)
 *   node scripts/jmap-auth-check.mjs
 *
 * BASE_URL overrides http://localhost:3000. The script signs in with the
 * seeded demo account and mints its own keys; pass JMAP_KEY to use an existing
 * key with the `jmap` scope instead. Optional:
 *
 *   OLD_KEY=ep_...       a key minted before the digest column existed: the
 *                        script times its first request (bcrypt, then the digest
 *                        is written) against the ones after it (digest lookup)
 *   IDENTITY_OUT=path    write the Identity/get list as JSON, to diff two builds
 *   BENCH=10             repeat the timed requests this many times (default 10)
 */

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DEMO = { email: "admin@example.com", password: "demo-password-change-me" };
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
const BENCH = Math.max(Number(process.env.BENCH ?? 10) || 10, 1);

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
	if (ok) {
		passed += 1;
		console.log(`  ok   ${name}`);
	} else {
		failed += 1;
		console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

let sessionCookie = null;

async function signIn() {
	if (sessionCookie) return sessionCookie;
	const login = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(DEMO),
	});
	if (!login.ok) throw new Error(`login failed (${login.status}); run npm run db:seed first`);
	sessionCookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
	return sessionCookie;
}

async function mintKey(name, scopes) {
	const created = await fetch(`${BASE}/api/api-keys`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: await signIn() },
		body: JSON.stringify({ name: `${name} ${Date.now()}`, scopes }),
	});
	if (!created.ok) throw new Error(`could not mint an API key (${created.status})`);
	return created.json();
}

async function revokeKey(id) {
	const response = await fetch(`${BASE}/api/api-keys/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Cookie: await signIn() } });
	return response.status;
}

const bearer = (key) => ({ Authorization: `Bearer ${key}` });
const basic = (key, user = "anyone") => ({ Authorization: `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}` });

/** One JMAP request; returns the method responses. */
async function jmap(key, methodCalls) {
	const response = await fetch(`${BASE}/jmap/api`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...bearer(key) },
		body: JSON.stringify({ using: USING, methodCalls }),
	});
	const body = await response.json();
	if (!response.ok) throw new Error(`JMAP ${response.status}: ${JSON.stringify(body)}`);
	return body.methodResponses;
}

function bundleCalls(accountId, inboxId) {
	return [
		["Mailbox/get", { accountId, ids: null }, "m"],
		["Email/query", { accountId, filter: { inMailbox: inboxId }, sort: [{ property: "receivedAt", isAscending: false }], limit: 50, collapseThreads: true }, "q"],
		["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["id", "threadId", "subject", "from", "receivedAt", "keywords", "preview", "blobId"] }, "g"],
		["Thread/get", { accountId, "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" } }, "t"],
	];
}

async function timed(fn) {
	const start = performance.now();
	await fn();
	return performance.now() - start;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const ms = (value) => `${value.toFixed(1)} ms`;

async function bench(label, fn) {
	await fn();
	const runs = [];
	for (let i = 0; i < BENCH; i += 1) runs.push(await timed(fn));
	console.log(`  time ${label}: median ${ms(median(runs))} (min ${ms(Math.min(...runs))}, max ${ms(Math.max(...runs))}, n=${BENCH})`);
}

async function main() {
	console.log(`Mailflare JMAP auth check against ${BASE}`);
	const minted = process.env.JMAP_KEY ? null : await mintKey("auth-check", ["jmap", "domains"]);
	const key = process.env.JMAP_KEY ?? minted.key;

	section("Authentication");
	const viaBearer = await fetch(`${BASE}/jmap/session`, { headers: bearer(key) });
	const session = await viaBearer.json();
	check("Bearer auth opens the session", viaBearer.status === 200 && typeof session.apiUrl === "string", viaBearer.status);
	const viaBasic = await fetch(`${BASE}/jmap/session`, { headers: basic(key) });
	check("Basic auth (key as the password) opens the session", viaBasic.status === 200, viaBasic.status);
	const viaBareBasic = await fetch(`${BASE}/jmap/session`, { headers: { Authorization: `Basic ${Buffer.from(key).toString("base64")}` } });
	check("Basic auth with no username separator opens the session", viaBareBasic.status === 200, viaBareBasic.status);
	const noAuth = await fetch(`${BASE}/jmap/session`);
	check("no credentials answer 401", noAuth.status === 401, noAuth.status);
	check("the 401 offers Basic and Bearer", /Basic/.test(noAuth.headers.get("www-authenticate") ?? "") && /Bearer/.test(noAuth.headers.get("www-authenticate") ?? ""), noAuth.headers.get("www-authenticate"));
	const wrongSecret = `${key.slice(0, 12)}${"x".repeat(Math.max(key.length - 12, 1))}`;
	const wrong = await fetch(`${BASE}/jmap/session`, { headers: bearer(wrongSecret) });
	check("a wrong key sharing the real key's prefix answers 401", wrong.status === 401, wrong.status);
	const garbage = await fetch(`${BASE}/jmap/session`, { headers: { Authorization: "Basic %%%not-base64" } });
	check("malformed Basic credentials answer 401", garbage.status === 401, garbage.status);
	if (minted) {
		const v1 = await fetch(`${BASE}/api/v1/domains`, { headers: bearer(key) });
		check("the same key reaches /api/v1/domains", v1.status === 200, v1.status);
		const readOnly = await mintKey("auth-check read", ["read"]);
		const noJmap = await fetch(`${BASE}/jmap/session`, { headers: bearer(readOnly.key) });
		check("a key without the jmap scope answers 403", noJmap.status === 403, noJmap.status);
		await revokeKey(readOnly.id);
	}

	const accountId = Object.keys(session.accounts ?? {})[0];
	check("the session names an account", typeof accountId === "string", session.accounts);

	section("CORS and autodiscovery");
	const preflight = await fetch(`${BASE}/jmap/api`, { method: "OPTIONS", headers: { Origin: "https://client.example", "Access-Control-Request-Method": "POST" } });
	check("OPTIONS /jmap/api answers 204", preflight.status === 204, preflight.status);
	check("the preflight allows any origin", preflight.headers.get("access-control-allow-origin") === "*", preflight.headers.get("access-control-allow-origin"));
	check("the preflight allows Authorization", /authorization/i.test(preflight.headers.get("access-control-allow-headers") ?? ""), preflight.headers.get("access-control-allow-headers"));
	check("the session response carries CORS headers", viaBearer.headers.get("access-control-allow-origin") === "*", viaBearer.headers.get("access-control-allow-origin"));
	const wellKnown = await fetch(`${BASE}/.well-known/jmap`, { redirect: "manual" });
	check("/.well-known/jmap redirects to the session", wellKnown.status === 301 && (wellKnown.headers.get("location") ?? "").endsWith("/jmap/session"), { status: wellKnown.status, location: wellKnown.headers.get("location") });
	const unknown = await fetch(`${BASE}/jmap/nothing-here`, { headers: bearer(key) });
	check("an unknown /jmap/ path answers 404 JSON", unknown.status === 404 && (unknown.headers.get("content-type") ?? "").includes("json"), unknown.status);

	section("Four-call bundle");
	const [[, mailboxes]] = await jmap(key, [["Mailbox/get", { accountId, ids: null }, "m"]]);
	const inbox = mailboxes.list.find((mailbox) => mailbox.role === "inbox" && mailbox.totalEmails > 0) ?? mailboxes.list.find((mailbox) => mailbox.role === "inbox");
	check("an Inbox is listed", Boolean(inbox), mailboxes.list.map((mailbox) => mailbox.name));
	const bundle = await jmap(key, bundleCalls(accountId, inbox.id));
	const byCall = Object.fromEntries(bundle.map(([name, result, callId]) => [callId, { name, result }]));
	check("every call answers without an error", bundle.every(([name]) => name !== "error"), bundle.filter(([name]) => name === "error"));
	const ids = byCall.q.result.ids ?? [];
	check("Email/query returns ids", ids.length > 0, byCall.q.result);
	check("Email/get returns one Email per id", (byCall.g.result.list ?? []).length === ids.length, { got: byCall.g.result.list?.length, want: ids.length });
	check("Thread/get returns a thread per Email", (byCall.t.result.list ?? []).length === new Set(byCall.g.result.list.map((email) => email.threadId)).size, byCall.t.result.notFound);

	section("Identity/get");
	const [[, identities]] = await jmap(key, [["Identity/get", { accountId, ids: null }, "i"]]);
	const list = identities.list ?? [];
	check("Identity/get lists identities", list.length > 0, identities);
	check("identity ids are unique", new Set(list.map((item) => item.id)).size === list.length);
	if (process.env.IDENTITY_OUT) {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(process.env.IDENTITY_OUT, `${JSON.stringify(list, null, "\t")}\n`);
		console.log(`  wrote ${list.length} identities to ${process.env.IDENTITY_OUT}`);
	}
	const [[, someIdentities]] = await jmap(key, [["Identity/get", { accountId, ids: [list[0]?.id, "nope"] }, "i"]]);
	check("Identity/get by id returns that identity and reports the unknown one", someIdentities.list?.length === 1 && someIdentities.notFound?.[0] === "nope", someIdentities);

	section("Blobs");
	const withRaw = byCall.g.result.list.find((email) => /^Attachment check/.test(email.subject ?? "")) ?? byCall.g.result.list[0];
	const downloadUrl = `${BASE}/jmap/download/${encodeURIComponent(accountId)}/${encodeURIComponent(withRaw.blobId)}/message.eml`;
	const download = await fetch(downloadUrl, { headers: basic(key) });
	const downloaded = await download.text();
	check("the message blob downloads with Basic auth", download.ok, download.status);
	check("the blob is the message's MIME", downloaded.includes(withRaw.subject ?? ""), downloaded.slice(0, 120));
	check("the download carries CORS headers", download.headers.get("access-control-allow-origin") === "*");
	const payload = new TextEncoder().encode(`auth-check upload ${Date.now()}\n`);
	const uploaded = await fetch(`${BASE}/jmap/upload/${encodeURIComponent(accountId)}`, { method: "POST", headers: { "Content-Type": "text/plain", ...bearer(key) }, body: payload });
	const stored = await uploaded.json();
	check("an upload answers 201 with a blobId", uploaded.status === 201 && typeof stored.blobId === "string", { status: uploaded.status, stored });
	const roundTrip = await fetch(`${BASE}/jmap/download/${encodeURIComponent(accountId)}/${encodeURIComponent(stored.blobId)}/upload.txt`, { headers: bearer(key) });
	const roundTripBytes = new Uint8Array(await roundTrip.arrayBuffer());
	check("the uploaded blob downloads byte for byte", roundTrip.ok && roundTripBytes.length === payload.length && roundTripBytes.every((byte, index) => byte === payload[index]), roundTrip.status);

	section("Event source");
	const events = await fetch(`${BASE}/jmap/eventsource?types=*&closeafter=state&ping=10`, { headers: { Accept: "text/event-stream", ...bearer(key) }, signal: AbortSignal.timeout(15_000) });
	check("the event source answers text/event-stream", events.ok && (events.headers.get("content-type") ?? "").startsWith("text/event-stream"), events.status);
	const eventText = await events.text();
	check("the event source sends a StateChange and closes", /event: state/.test(eventText) && eventText.includes("StateChange"), eventText.slice(0, 200));
	const live = await fetch(`${BASE}/jmap/eventsource?types=*&ping=10`, { headers: { Accept: "text/event-stream", ...bearer(key) } });
	const reader = live.body.getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	check("a long-lived event source streams its first state at once", first.includes("StateChange"), first.slice(0, 120));
	await reader.cancel();

	if (minted) {
		section("Revocation");
		const doomed = await mintKey("auth-check revoke", ["jmap", "domains"]);
		const before = await fetch(`${BASE}/jmap/session`, { headers: bearer(doomed.key) });
		check("a fresh key works before it is revoked", before.status === 200, before.status);
		const beforeV1 = await fetch(`${BASE}/api/v1/domains`, { headers: bearer(doomed.key) });
		check("and on /api/v1/domains", beforeV1.status === 200, beforeV1.status);
		check("revoking it answers 200", (await revokeKey(doomed.id)) === 200);
		const after = await fetch(`${BASE}/jmap/session`, { headers: bearer(doomed.key) });
		check("the next JMAP request with the revoked key answers 401", after.status === 401, after.status);
		const afterBasic = await fetch(`${BASE}/jmap/session`, { headers: basic(doomed.key) });
		check("so does Basic auth", afterBasic.status === 401, afterBasic.status);
		const afterV1 = await fetch(`${BASE}/api/v1/domains`, { headers: bearer(doomed.key) });
		check("and /api/v1/domains answers 401", afterV1.status === 401, afterV1.status);
	}

	if (process.env.OLD_KEY) {
		section("Key minted before the digest column");
		const firstCall = await timed(async () => {
			const response = await fetch(`${BASE}/jmap/session`, { headers: bearer(process.env.OLD_KEY) });
			check("the old key still opens the session", response.status === 200, response.status);
		});
		const later = [];
		for (let i = 0; i < BENCH; i += 1) {
			later.push(await timed(async () => {
				const response = await fetch(`${BASE}/jmap/session`, { headers: bearer(process.env.OLD_KEY) });
				if (response.status !== 200) throw new Error(`old key answered ${response.status} on a later call`);
			}));
		}
		console.log(`  time first call ${ms(firstCall)}, later calls median ${ms(median(later))} (n=${BENCH})`);
	}

	section(`Timings (median of ${BENCH})`);
	await bench("GET /jmap/session", async () => {
		const response = await fetch(`${BASE}/jmap/session`, { headers: bearer(key) });
		await response.arrayBuffer();
	});
	await bench("four-call bundle", () => jmap(key, bundleCalls(accountId, inbox.id)));
	await bench("blob download", async () => {
		const response = await fetch(downloadUrl, { headers: bearer(key) });
		await response.arrayBuffer();
	});
	await bench("Identity/get", () => jmap(key, [["Identity/get", { accountId, ids: null }, "i"]]));

	if (minted) await revokeKey(minted.id);
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
