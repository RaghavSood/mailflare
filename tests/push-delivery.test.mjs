import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Push subscriptions, the producer's suppression rule and the queue consumer,
 * against a real SQLite database with the repository's migrations (through the
 * self-hosted runtime's D1 wrapper). Realtime hubs, the queue and the push
 * service are plain objects standing in for bindings.
 */
const cacheDir = join(root, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "mailflare-push-delivery-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { users, pushSubscriptions } from "./src/db/schema/index.ts";
			export { assertBackupTablesCoverDatabase } from "./src/lib/backups/export.ts";
			export * from "./src/lib/push/push-utils.ts";
			export { savePushSubscription, removePushSubscription, countPushSubscriptions, isPushSubscriptionRegistered, enqueuePushNotifications, processPushMessage } from "./src/lib/push/delivery.ts";
			export { createSession, deleteSession, deleteUserSessions, getSessionIdFromToken } from "./src/lib/auth/session.ts";
			export { users as usersTable, sessions } from "./src/db/schema/index.ts";
			export { derivePushKeys } from "./src/lib/push/encrypt-utils.ts";
			export { base64UrlDecode, base64UrlEncode } from "./src/lib/push/encoding-utils.ts";
			export { vapidKeyId, verifyVapidJwt } from "./src/lib/push/vapid-utils.ts";
			export { notifyUsersOfNewMessage } from "./src/lib/realtime/utils.ts";
			export { isPushMessage, isWebhookRetryMessage, isInboundQueueMessage } from "./worker-utils.ts";
			export { eq } from "drizzle-orm";
		`,
		resolveDir: root,
		sourcefile: "push-delivery-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3"],
	logLevel: "silent",
});

const m = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

let database;
let db;
let vapid;
let currentKeyId;
/** One signed-in session per user, recreated before every test: { token, id }. */
let sessionOf = {};

/** Stores a subscription as /v2/push/subscribe does: for the user's session, under the current key unless told otherwise. */
function save(userId, input, userAgent = null, owner = {}) {
	return m.savePushSubscription(
		{ DB: database },
		{ userId, sessionId: owner.sessionId ?? sessionOf[userId].id, vapidKeyId: owner.vapidKeyId ?? currentKeyId },
		input,
		userAgent,
	);
}

async function newVapid() {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const publicKey = m.base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
	const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
	return { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: d, VAPID_SUBJECT: "mailto:admin@example.test" };
}

/** A browser's side of a subscription: its keys, and a way to read what it is sent. */
async function newBrowser(endpoint) {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return {
		subscription: { endpoint, keys: { p256dh: m.base64UrlEncode(publicKey), auth: m.base64UrlEncode(auth) } },
		async decrypt(body) {
			const salt = body.subarray(0, 16);
			const senderPublicKey = body.subarray(21, 86);
			const sender = await crypto.subtle.importKey("raw", senderPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
			const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, pair.privateKey, 256));
			const { cek, nonce } = await m.derivePushKeys({ ecdhSecret, authSecret: auth, userAgentPublicKey: publicKey, senderPublicKey, salt });
			const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
			const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.subarray(86)));
			assert.equal(padded.at(-1), 0x02);
			return JSON.parse(new TextDecoder().decode(padded.subarray(0, -1)));
		},
	};
}

/** Realtime hubs that report `open[userId]` sockets and record notifies; a queue that records sends. */
function fakeEnv(open = {}, extra = {}) {
	const queued = [];
	const notified = [];
	const env = {
		DB: database,
		...vapid,
		REALTIME: {
			getByName: (userId) => ({
				async fetch(input, init) {
					const request = new Request(input, init);
					const { pathname } = new URL(request.url);
					if (pathname === "/connections") {
						if (open[userId] === "error") throw new Error("hub unavailable");
						return Response.json({ connections: open[userId] ?? 0 });
					}
					if (pathname === "/notify") {
						notified.push([userId, await request.json()]);
						return new Response(null, { status: 204 });
					}
					return new Response("Not found", { status: 404 });
				},
			}),
		},
		OUTBOUND_QUEUE: {
			async send(body, options) { queued.push({ body, delaySeconds: options?.delaySeconds }); },
			async sendBatch(messages) { for (const message of messages) queued.push(message); },
		},
		...extra,
	};
	return { env, queued, notified };
}

const NOTICE = { messageId: "msg_1", from: "alice@example.org", fromName: "Alice", subject: "Lunch?" };

before(async () => {
	database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, join(root, "drizzle", "migrations"));
	db = m.createDb(database);
	for (const id of ["usr_a", "usr_b", "usr_c"]) {
		await db.insert(m.users).values({ id, email: `${id}@example.test`, passwordHash: "x", name: id });
	}
	vapid = await newVapid();
	currentKeyId = await m.vapidKeyId(vapid.VAPID_PUBLIC_KEY);
});

beforeEach(async () => {
	await db.delete(m.pushSubscriptions);
	await db.delete(m.sessions);
	sessionOf = {};
	for (const userId of ["usr_a", "usr_b", "usr_c"]) {
		const token = await m.createSession({ DB: database }, userId);
		sessionOf[userId] = { token, id: await m.getSessionIdFromToken({ DB: database }, token) };
	}
});

test("migration 0036 creates push_subscriptions and backups cover it", async () => {
	const columns = database.db.prepare("PRAGMA table_info(push_subscriptions)").all().map((column) => column.name);
	assert.deepEqual(columns, ["id", "user_id", "session_id", "vapid_key_id", "endpoint", "p256dh", "auth", "user_agent", "created_at", "last_used_at", "failed_at"]);
	await m.assertBackupTablesCoverDatabase(database);
});

test("parsePushSubscription accepts a browser's PushSubscription JSON and refuses anything the server should not POST to", async () => {
	const { subscription } = await newBrowser("https://fcm.googleapis.com/fcm/send/abc:DEF");
	assert.deepEqual(m.parsePushSubscription(subscription), { endpoint: subscription.endpoint, ...subscription.keys });
	// Padded keys, as some browsers once produced, are accepted and stored unpadded.
	assert.equal(m.parsePushSubscription({ ...subscription, keys: { p256dh: `${subscription.keys.p256dh}=`, auth: `${subscription.keys.auth}==` } })?.auth, subscription.keys.auth);
	for (const endpoint of [
		"http://fcm.googleapis.com/fcm/send/abc",
		"https://127.0.0.1/push",
		"https://[::1]/push",
		"https://localhost/push",
		"https://intranet/push",
		"https://push.corp.internal/x",
		"https://printer.local/x",
		"https://user:pw@fcm.googleapis.com/x",
		"https://fcm.googleapis.com:8443/x",
		"not a url",
		`https://fcm.googleapis.com/${"a".repeat(2100)}`,
	]) {
		assert.equal(m.parsePushSubscription({ ...subscription, endpoint }), null, endpoint);
	}
	assert.equal(m.parsePushSubscription({ endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: "AAAA" } }), null);
	assert.equal(m.parsePushSubscription({ endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.auth, auth: subscription.keys.auth } }), null);
	assert.equal(m.parsePushSubscription({ endpoint: subscription.endpoint }), null);
	assert.equal(m.parsePushSubscription(null), null);
});

test("push config needs all three VAPID values, well formed, and the status never echoes them", async () => {
	assert.deepEqual(m.getPushConfig(vapid), { publicKey: vapid.VAPID_PUBLIC_KEY, privateKey: vapid.VAPID_PRIVATE_KEY, subject: vapid.VAPID_SUBJECT });
	assert.equal(m.getPushConfig({ ...vapid, VAPID_SUBJECT: "" }), null);
	assert.equal(m.getPushConfig({ ...vapid, VAPID_PRIVATE_KEY: "short" }), null);
	assert.equal(m.getPushConfig({ ...vapid, VAPID_SUBJECT: "admin@example.test" }), null);
	assert.deepEqual(m.describePushConfig(vapid), { configured: true, problems: [] });
	const broken = m.describePushConfig({ VAPID_PUBLIC_KEY: "nope", VAPID_SUBJECT: "x" });
	assert.equal(broken.configured, false);
	assert.equal(broken.problems.length, 3);
	assert.ok(broken.problems.every((problem) => !problem.includes("nope")));
});

test("status codes map to delivered, gone, retry and failed; retries back off to a cap", () => {
	assert.deepEqual([201, 200, 404, 410, 429, 500, 503, 400, 401, 403, 413].map(m.classifyPushStatus),
		["delivered", "delivered", "gone", "gone", "retry", "retry", "retry", "failed", "failed", "failed", "failed"]);
	assert.deepEqual([2, 3, 4, 5, 6, 7, 8, 20].map(m.pushRetryDelaySeconds), [30, 60, 120, 240, 480, 600, 600, 600]);
});

test("the notice carries sender and subject only, clipped and whitespace-folded", () => {
	const notice = m.buildPushNotification({ messageId: "msg_9", from: "a@b.c", fromName: "  Ann \n Lee ", subject: "x".repeat(500), mailboxId: "mbx", type: "new_message", textBody: "secret" });
	assert.deepEqual(Object.keys(notice), ["messageId", "from", "fromName", "subject"]);
	assert.equal(notice.fromName, "Ann Lee");
	assert.equal(notice.subject.length, 200);
	assert.equal(m.buildPushNotification({ messageId: "m", from: "a@b.c", fromName: null, subject: "  " }).subject, null);
});

test("isPushMessage tells push jobs from the outbound queue's other payloads", () => {
	const job = { kind: "push.notify", userId: "usr_a", notification: NOTICE };
	assert.equal(m.isPushMessage(job), true);
	assert.equal(m.isPushMessage({ ...job, kind: "webhook.retry" }), false);
	assert.equal(m.isPushMessage({ kind: "push.notify", userId: "usr_a" }), false);
	assert.equal(m.isWebhookRetryMessage(job), false);
	assert.equal(m.isInboundQueueMessage(job), false);
	assert.equal(m.isPushMessage({ deliveryId: "d", kind: "webhook.retry" }), false);
});

test("selectPushRecipients: only subscribed users with no open socket; an unknown count still notifies", () => {
	const open = new Map([["usr_a", 0], ["usr_b", 2], ["usr_c", null]]);
	assert.deepEqual(m.selectPushRecipients(["usr_a", "usr_b", "usr_c", "usr_d", "usr_a"], ["usr_a", "usr_b", "usr_c"], open), ["usr_a", "usr_c"]);
	assert.deepEqual(m.selectPushRecipients(["usr_a"], [], open), []);
});

test("subscribe upserts by endpoint, moves an endpoint to the user now signed in, and caps each user's devices", async () => {
	const { env } = fakeEnv();
	const browser = await newBrowser("https://fcm.googleapis.com/fcm/send/one");
	const input = m.parsePushSubscription(browser.subscription);
	await save("usr_a", input, "UA 1");
	await save("usr_a", input, "UA 2");
	let rows = await db.select().from(m.pushSubscriptions);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].userAgent, "UA 2");

	await save("usr_b", input, "UA 3");
	rows = await db.select().from(m.pushSubscriptions);
	assert.deepEqual(rows.map((row) => row.userId), ["usr_b"]);

	// Unsubscribing is scoped to the user: usr_a cannot remove usr_b's endpoint.
	await m.removePushSubscription(env, "usr_a", input.endpoint);
	assert.equal(await m.countPushSubscriptions(env), 1);
	await m.removePushSubscription(env, "usr_b", input.endpoint);
	assert.equal(await m.countPushSubscriptions(env), 0);

	for (let index = 0; index < m.MAX_SUBSCRIPTIONS_PER_USER + 3; index += 1) {
		await db.insert(m.pushSubscriptions).values({ id: `push_${index}`, userId: "usr_c", sessionId: sessionOf.usr_c.id, vapidKeyId: currentKeyId, endpoint: `https://fcm.googleapis.com/fcm/send/${index}`, p256dh: input.p256dh, auth: input.auth, createdAt: new Date(1_700_000_000_000 + index * 1000) });
	}
	await save("usr_c", m.parsePushSubscription((await newBrowser("https://fcm.googleapis.com/fcm/send/newest")).subscription), null);
	rows = await db.select().from(m.pushSubscriptions).where(m.eq(m.pushSubscriptions.userId, "usr_c"));
	assert.equal(rows.length, m.MAX_SUBSCRIPTIONS_PER_USER);
	assert.ok(rows.some((row) => row.endpoint.endsWith("/newest")));
	assert.ok(!rows.some((row) => row.id === "push_0" || row.id === "push_3"));
});

test("producer suppresses the push for a user with an open socket and queues one job per other subscribed user", async () => {
	const { env, queued } = fakeEnv({ usr_a: 1, usr_b: 0, usr_c: "error" });
	for (const [userId, name] of [["usr_a", "a1"], ["usr_b", "b1"], ["usr_b", "b2"], ["usr_c", "c1"]]) {
		await save(userId, m.parsePushSubscription((await newBrowser(`https://fcm.googleapis.com/fcm/send/${name}`)).subscription), null);
	}
	const recipients = await m.enqueuePushNotifications(env, ["usr_a", "usr_b", "usr_c"], NOTICE);
	assert.deepEqual(recipients.sort(), ["usr_b", "usr_c"]);
	// One job per user, however many devices they have; the consumer fans out.
	assert.deepEqual(queued.map((job) => job.body.userId).sort(), ["usr_b", "usr_c"]);
	assert.ok(queued.every((job) => job.body.kind === "push.notify" && job.body.notification === NOTICE && job.delaySeconds === undefined));
});

test("producer does nothing when push is not configured or nobody subscribed", async () => {
	const { env, queued } = fakeEnv({}, { VAPID_PRIVATE_KEY: undefined });
	await save("usr_a", m.parsePushSubscription((await newBrowser("https://fcm.googleapis.com/fcm/send/x")).subscription), null);
	assert.deepEqual(await m.enqueuePushNotifications(env, ["usr_a"], NOTICE), []);
	const configured = fakeEnv();
	assert.deepEqual(await m.enqueuePushNotifications(configured.env, ["usr_b"], NOTICE), []);
	assert.equal(queued.length + configured.queued.length, 0);
});

test("notifyUsersOfNewMessage notifies every hub and queues pushes only for users without an open socket", async () => {
	const { env, queued, notified } = fakeEnv({ usr_a: 1 });
	for (const userId of ["usr_a", "usr_b"]) {
		await save(userId, m.parsePushSubscription((await newBrowser(`https://fcm.googleapis.com/fcm/send/${userId}`)).subscription), null);
	}
	const payload = { type: "new_message", mailboxId: "mbx", ...NOTICE };
	await m.notifyUsersOfNewMessage(env, ["usr_a", "usr_b"], payload);
	assert.deepEqual(notified.map(([userId]) => userId).sort(), ["usr_a", "usr_b"]);
	assert.deepEqual(queued.map((job) => job.body), [{ kind: "push.notify", userId: "usr_b", notification: NOTICE }]);

	// A queue that refuses never fails inbound processing.
	const broken = fakeEnv();
	broken.env.OUTBOUND_QUEUE.sendBatch = async () => { throw new Error("queue down"); };
	const errors = [];
	const original = console.error;
	console.error = (...args) => errors.push(args);
	try {
		await m.notifyUsersOfNewMessage(broken.env, ["usr_b"], payload);
	} finally {
		console.error = original;
	}
	assert.equal(broken.notified.length, 1);
	assert.match(String(errors[0]?.[0]), /push/);
});

/** Replaces fetch with a push service that answers `statusFor(endpoint)` and records requests. */
async function withPushService(statusFor, run) {
	const requests = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
		return new Response(null, { status: statusFor(request.url) });
	};
	const warn = console.warn;
	console.warn = () => {};
	try {
		return await run(requests);
	} finally {
		globalThis.fetch = original;
		console.warn = warn;
	}
}

test("consumer encrypts for each device; 201 stamps last_used_at, 410 deletes, 503 retries that device alone, 403 is recorded and dropped", async () => {
	const { env, queued } = fakeEnv();
	const browsers = {};
	for (const name of ["ok", "gone", "busy", "forbidden"]) {
		browsers[name] = await newBrowser(`https://push.example.net/${name}`);
		await save("usr_a", m.parsePushSubscription(browsers[name].subscription), null);
	}
	await save("usr_b", m.parsePushSubscription((await newBrowser("https://push.example.net/other-user")).subscription), null);
	const status = { ok: 201, gone: 410, busy: 503, forbidden: 403 };

	const summary = await withPushService((url) => status[url.split("/").pop()], async (requests) => {
		const result = await m.processPushMessage(env, { kind: "push.notify", userId: "usr_a", notification: NOTICE });
		assert.equal(requests.length, 4);
		for (const request of requests) {
			assert.equal(request.headers.get("content-encoding"), "aes128gcm");
			assert.equal(request.headers.get("ttl"), String(m.PUSH_TTL_SECONDS));
			const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.get("authorization"));
			assert.equal(key, vapid.VAPID_PUBLIC_KEY);
			assert.equal((await m.verifyVapidJwt(token, key)).aud, "https://push.example.net");
			// Each device can decrypt exactly the notice, and nothing else is in it.
			assert.deepEqual(await browsers[request.url.split("/").pop()].decrypt(request.body), NOTICE);
		}
		return result;
	});
	assert.deepEqual(summary, { delivered: 1, removed: 1, failed: 2, retried: 1 });

	const rows = Object.fromEntries((await db.select().from(m.pushSubscriptions).where(m.eq(m.pushSubscriptions.userId, "usr_a"))).map((row) => [row.endpoint.split("/").pop(), row]));
	assert.deepEqual(Object.keys(rows).sort(), ["busy", "forbidden", "ok"]);
	assert.ok(rows.ok.lastUsedAt instanceof Date && rows.ok.failedAt === null);
	assert.ok(rows.busy.failedAt instanceof Date && rows.busy.lastUsedAt === null);
	assert.ok(rows.forbidden.failedAt instanceof Date);

	assert.equal(queued.length, 1);
	assert.deepEqual(queued[0], {
		body: { kind: "push.notify", userId: "usr_a", notification: NOTICE, subscriptionId: rows.busy.id, attempt: 1 },
		delaySeconds: 30,
	});

	// The retry goes to that device only, and a success clears failed_at.
	await withPushService(() => 201, async (requests) => {
		assert.deepEqual(await m.processPushMessage(env, queued[0].body), { delivered: 1, removed: 0, failed: 0, retried: 0 });
		assert.deepEqual(requests.map((request) => request.url), ["https://push.example.net/busy"]);
	});
	const [busy] = await db.select().from(m.pushSubscriptions).where(m.eq(m.pushSubscriptions.id, rows.busy.id));
	assert.equal(busy.failedAt, null);
	assert.ok(busy.lastUsedAt instanceof Date);
});

test("consumer gives up after the last attempt, survives network errors, and is a no-op once push is unconfigured", async () => {
	const { env, queued } = fakeEnv();
	await save("usr_a", m.parsePushSubscription((await newBrowser("https://push.example.net/flaky")).subscription), null);
	const [row] = await db.select().from(m.pushSubscriptions);

	const original = globalThis.fetch;
	const warn = console.warn;
	globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
	console.warn = () => {};
	try {
		const retry = { kind: "push.notify", userId: "usr_a", notification: NOTICE, subscriptionId: row.id };
		assert.deepEqual(await m.processPushMessage(env, { ...retry, attempt: 1 }), { delivered: 0, removed: 0, failed: 1, retried: 1 });
		assert.deepEqual(queued.at(-1), { body: { ...retry, attempt: 2 }, delaySeconds: 60 });
		assert.deepEqual(await m.processPushMessage(env, { ...retry, attempt: m.MAX_PUSH_ATTEMPTS - 1 }), { delivered: 0, removed: 0, failed: 1, retried: 0 });
		assert.equal(queued.length, 1);
		// A retry naming another user's subscription sends nothing.
		assert.deepEqual(await m.processPushMessage(env, { ...retry, userId: "usr_b" }), { delivered: 0, removed: 0, failed: 0, retried: 0 });
	} finally {
		globalThis.fetch = original;
		console.warn = warn;
	}

	const unconfigured = fakeEnv({}, { VAPID_PUBLIC_KEY: undefined });
	assert.deepEqual(await m.processPushMessage(unconfigured.env, { kind: "push.notify", userId: "usr_a", notification: NOTICE }), { delivered: 0, removed: 0, failed: 0, retried: 0 });
});

/** Counts what the push service is asked for while `run` executes; it would answer 201. */
async function countingPushService(run) {
	const urls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (input) => {
		urls.push(new Request(input).url);
		return new Response(null, { status: 201 });
	};
	try {
		return { result: await run(), urls };
	} finally {
		globalThis.fetch = original;
	}
}

test("vapidKeyId is a short stable name that differs between keys", async () => {
	const other = await newVapid();
	assert.equal(currentKeyId.length, 16);
	assert.equal(await m.vapidKeyId(vapid.VAPID_PUBLIC_KEY), currentKeyId);
	assert.equal(await m.vapidKeyId(` ${vapid.VAPID_PUBLIC_KEY}\n`), currentKeyId);
	assert.notEqual(await m.vapidKeyId(other.VAPID_PUBLIC_KEY), currentKeyId);
	assert.ok(!currentKeyId.includes(vapid.VAPID_PUBLIC_KEY.slice(0, 8)), "names the key without echoing it");
});

test("partitionSubscriptions keeps rows with a live session and the current key, and marks the rest dead", () => {
	const now = new Date("2026-10-14T12:00:00Z");
	const later = new Date("2026-10-20T12:00:00Z");
	const rows = [
		{ id: "live", vapidKeyId: "k1", sessionExpiresAt: later },
		{ id: "signed-out", vapidKeyId: "k1", sessionExpiresAt: null },
		{ id: "expired", vapidKeyId: "k1", sessionExpiresAt: new Date("2026-10-14T11:59:59Z") },
		{ id: "old-key", vapidKeyId: "k0", sessionExpiresAt: later },
	];
	const { live, stale } = m.partitionSubscriptions(rows, { vapidKeyId: "k1", now });
	assert.deepEqual(live.map((row) => row.id), ["live"]);
	assert.deepEqual(stale.map((row) => row.id), ["signed-out", "expired", "old-key"]);
});

test("subscribing binds the row to the signed-in session; moving to another user moves the session too", async () => {
	const input = m.parsePushSubscription((await newBrowser("https://fcm.googleapis.com/fcm/send/bound")).subscription);
	await save("usr_a", input);
	let [row] = await db.select().from(m.pushSubscriptions);
	assert.equal(row.sessionId, sessionOf.usr_a.id);
	assert.equal(row.vapidKeyId, currentKeyId);
	assert.equal(await m.isPushSubscriptionRegistered({ DB: database }, "usr_a", input.endpoint), true);
	await save("usr_b", input);
	[row] = await db.select().from(m.pushSubscriptions);
	assert.deepEqual([row.userId, row.sessionId], ["usr_b", sessionOf.usr_b.id]);
	assert.equal(await m.isPushSubscriptionRegistered({ DB: database }, "usr_a", input.endpoint), false);
	assert.equal(await m.getSessionIdFromToken({ DB: database }, "sess_not_a_real_token"), null);
});

test("signing out deletes that session's subscriptions, and a delivery afterwards sends nothing", async () => {
	const { env, queued } = fakeEnv();
	const input = m.parsePushSubscription((await newBrowser("https://push.example.net/phone")).subscription);
	await save("usr_a", input);
	await save("usr_b", m.parsePushSubscription((await newBrowser("https://push.example.net/other")).subscription));

	await m.deleteSession({ DB: database }, sessionOf.usr_a.token);
	assert.equal(await m.isPushSubscriptionRegistered(env, "usr_a", input.endpoint), false);
	assert.deepEqual((await db.select().from(m.pushSubscriptions)).map((row) => row.userId), ["usr_b"]);

	assert.deepEqual(await m.enqueuePushNotifications(env, ["usr_a"], NOTICE), []);
	const { result, urls } = await countingPushService(() => m.processPushMessage(env, { kind: "push.notify", userId: "usr_a", notification: NOTICE }));
	assert.deepEqual(result, { delivered: 0, removed: 0, failed: 0, retried: 0 });
	assert.deepEqual(urls, []);
	assert.equal(queued.length, 0);
});

test("signing out everywhere (password change) keeps only the session that asked", async () => {
	const second = await m.createSession({ DB: database }, "usr_a");
	const secondId = await m.getSessionIdFromToken({ DB: database }, second);
	await save("usr_a", m.parsePushSubscription((await newBrowser("https://push.example.net/laptop")).subscription));
	await save("usr_a", m.parsePushSubscription((await newBrowser("https://push.example.net/phone")).subscription), null, { sessionId: secondId });

	await m.deleteUserSessions({ DB: database }, "usr_a", second);
	assert.deepEqual((await db.select().from(m.pushSubscriptions)).map((row) => row.endpoint), ["https://push.example.net/phone"]);
	await m.deleteUserSessions({ DB: database }, "usr_a");
	assert.equal(await m.countPushSubscriptions({ DB: database }), 0);
});

test("a row whose session expired is deleted unsent and never queued", async () => {
	const { env, queued } = fakeEnv();
	await save("usr_a", m.parsePushSubscription((await newBrowser("https://push.example.net/stale")).subscription));
	await db.update(m.sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(m.eq(m.sessions.id, sessionOf.usr_a.id));

	assert.deepEqual(await m.enqueuePushNotifications(env, ["usr_a"], NOTICE), []);
	const { result, urls } = await countingPushService(() => m.processPushMessage(env, { kind: "push.notify", userId: "usr_a", notification: NOTICE }));
	assert.deepEqual(result, { delivered: 0, removed: 1, failed: 0, retried: 0 });
	assert.deepEqual(urls, []);
	assert.equal(await m.countPushSubscriptions(env), 0);
	assert.equal(queued.length, 0);
});

test("after a VAPID key change, rows made under the old key are deleted instead of failing with 403 on every message", async () => {
	const { env } = fakeEnv();
	const oldKeyId = await m.vapidKeyId((await newVapid()).VAPID_PUBLIC_KEY);
	await save("usr_a", m.parsePushSubscription((await newBrowser("https://push.example.net/old-key")).subscription), null, { vapidKeyId: oldKeyId });
	await save("usr_a", m.parsePushSubscription((await newBrowser("https://push.example.net/new-key")).subscription));
	await save("usr_b", m.parsePushSubscription((await newBrowser("https://push.example.net/only-old")).subscription), null, { vapidKeyId: oldKeyId });

	// The producer counts only subscriptions it could deliver to.
	assert.deepEqual((await m.enqueuePushNotifications(env, ["usr_a", "usr_b"], NOTICE)).sort(), ["usr_a"]);

	const { result, urls } = await countingPushService(() => m.processPushMessage(env, { kind: "push.notify", userId: "usr_a", notification: NOTICE }));
	assert.deepEqual(result, { delivered: 1, removed: 1, failed: 0, retried: 0 });
	assert.deepEqual(urls, ["https://push.example.net/new-key"]);
	const second = await countingPushService(() => m.processPushMessage(env, { kind: "push.notify", userId: "usr_b", notification: NOTICE }));
	assert.deepEqual(second.result, { delivered: 0, removed: 1, failed: 0, retried: 0 });
	assert.deepEqual(second.urls, []);
	assert.deepEqual((await db.select().from(m.pushSubscriptions)).map((row) => row.endpoint), ["https://push.example.net/new-key"]);
});
