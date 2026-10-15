import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "public/sw.js"), "utf8");
const offlineSource = readFileSync(join(root, "public/v2-assets/offline.js"), "utf8");
const ORIGIN = "https://mail.example.com";

const abs = (key) => new URL(typeof key === "string" ? key : key.url, ORIGIN).href;

/** Cache Storage's behaviour as far as the worker relies on it: insertion order, search and Vary options. */
class FakeCache {
	constructor() {
		this.entries = new Map();
	}
	async addAll(requests) {
		for (const request of requests) this.entries.set(abs(request), new Response(`cached ${request.url}`));
	}
	async put(key, response) {
		this.entries.delete(abs(key));
		this.entries.set(abs(key), response);
	}
	async delete(key) {
		return this.entries.delete(abs(key));
	}
	async keys() {
		return [...this.entries.keys()].map((url) => new Request(url));
	}
	async match(key, options = {}) {
		const wanted = new URL(abs(key));
		for (const [url, response] of this.entries) {
			const have = new URL(url);
			if (have.origin + have.pathname === wanted.origin + wanted.pathname && (options.ignoreSearch || have.search === wanted.search)) return response.clone();
		}
		return undefined;
	}
}

/** A fetch response as the browser hands it to a worker. */
function served(body, { status = 200, redirected = false, headers = { "Content-Type": "text/html; charset=utf-8" } } = {}) {
	const response = new Response(body, { status, headers });
	Object.defineProperty(response, "type", { value: "basic" });
	Object.defineProperty(response, "redirected", { value: redirected });
	return response;
}

const doc = (user, text = "inbox") => `<!doctype html>\n<html><head><title>${text}</title></head><body hx-boost="true" data-sw="/sw.js" data-user="${user}"><main id="main">${text}</main></body></html>`;

/** An IndexedDB request: the result arrives on onsuccess a moment after the call, as in a browser. */
class FakeIDBRequest {
	constructor() {
		this.result = undefined;
		this.error = null;
		this.onsuccess = null;
		this.onerror = null;
	}
}

/**
 * IndexedDB as far as offline.js uses it (open with an upgrade, one store per transaction, get, getAll,
 * put, delete, clear), kept in plain Maps the tests can seed and read: databases → stores → key → value.
 */
function fakeIndexedDB() {
	const databases = new Map();
	const later = (fn) => setTimeout(fn, 0);
	const database = (stores) => ({
		objectStoreNames: { contains: (name) => stores.has(name) },
		createObjectStore: (name, { keyPath } = {}) => stores.set(name, { keyPath, data: new Map() }),
		transaction: (name, mode) => {
			const store = stores.get(name);
			const transaction = { oncomplete: null, onerror: null, onabort: null };
			const op = (fn) => {
				const request = new FakeIDBRequest();
				request.result = fn();
				later(() => request.onsuccess?.());
				return request;
			};
			const writable = () => assert.equal(mode, "readwrite", `a write to ${name} in a ${mode} transaction`);
			transaction.objectStore = () => ({
				get: (key) => op(() => structuredClone(store.data.get(key))),
				getAll: () => op(() => [...store.data.values()].map((value) => structuredClone(value))),
				put: (value, key) => op(() => (writable(), store.data.set(key ?? value[store.keyPath], structuredClone(value)), key ?? value[store.keyPath])),
				delete: (key) => op(() => void (writable(), store.data.delete(key))),
				clear: () => op(() => void (writable(), store.data.clear())),
			});
			later(() => later(() => transaction.oncomplete?.()));
			return transaction;
		},
	});
	const indexedDB = {
		open: (name) => {
			const request = new FakeIDBRequest();
			later(() => {
				const fresh = !databases.has(name);
				if (fresh) databases.set(name, new Map());
				request.result = database(databases.get(name));
				if (fresh) request.onupgradeneeded?.();
				request.onsuccess?.();
			});
			return request;
		},
	};
	return { indexedDB, databases };
}

/** Loads public/sw.js (and the offline.js it imports) in a sandbox with fake caches and network. */
function loadWorker({ online = true, respond } = {}) {
	const listeners = {};
	const stores = new Map([["mf-static-6-2.0.11", new FakeCache()], ["other-cache", new FakeCache()]]);
	const opened = [];
	const deleted = [];
	const waits = [];
	const network = { online, respond: respond ?? ((request) => served(`network ${request.url}`)) };
	const posted = [];
	const caches = {
		open: async (name) => {
			opened.push(name);
			if (!stores.has(name)) stores.set(name, new FakeCache());
			return stores.get(name);
		},
		keys: async () => [...stores.keys()],
		delete: async (name) => {
			deleted.push(name);
			return stores.delete(name);
		},
		match: async (request, options = {}) => stores.get(options.cacheName)?.match(request, options),
	};
	const idb = fakeIndexedDB();
	const locks = [];
	const self = {
		location: new URL(`${ORIGIN}/sw.js?v=7&htmx=2.0.11`),
		registration: {},
		clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (message) => posted.push(message) }] },
		skipWaiting: async () => {},
		addEventListener: (type, fn) => {
			listeners[type] = fn;
		},
		caches,
		indexedDB: idb.indexedDB,
		navigator: {
			locks: {
				request: async (name, fn) => {
					locks.push({ name, held: true });
					try {
						return await fn();
					} finally {
						locks.at(-1).held = false;
					}
				},
			},
		},
	};
	const fetch = async (request, init) => {
		if (!network.online) throw new TypeError("Failed to fetch");
		return network.respond(request, init);
	};
	// Workers resolve relative URLs against their own location; Node's Request does not.
	const WorkerRequest = class extends Request {
		constructor(input, init) {
			super(typeof input === "string" ? new URL(input, self.location.href) : input, init);
		}
	};
	const imported = [];
	const context = vm.createContext({ self, caches, fetch, Request: WorkerRequest, Response, Headers, URL, Promise, FormData, IDBRequest: FakeIDBRequest, atob, btoa, console });
	context.importScripts = (url) => {
		imported.push(url);
		vm.runInContext(offlineSource, context);
	};
	vm.runInContext(source, context);
	const worker = { listeners, stores, opened, deleted, waits, network, imported, posted, self, databases: idb.databases, locks };
	worker.idle = async () => {
		while (waits.length) await Promise.all(waits.splice(0));
	};
	return worker;
}

/** Dispatches a fetch event and returns the promised response, or null when the worker stays out of it. */
function dispatchFetch(worker, url, init = {}) {
	const request = new Request(new URL(url, ORIGIN), { headers: init.headers });
	const fake = {
		method: init.method ?? "GET",
		mode: init.mode ?? "navigate",
		destination: init.destination ?? "document",
		headers: request.headers,
		url: request.url,
	};
	let responded = null;
	worker.listeners.fetch({
		request: fake,
		respondWith: (value) => {
			responded = Promise.resolve(value);
		},
		waitUntil: (promise) => worker.waits.push(promise),
	});
	return responded;
}

/** A fetch made by htmx (an XHR): not a navigation, and it says so. */
const xhr = { mode: "cors", destination: "", headers: { "HX-Request": "true" } };

async function installed(options) {
	const worker = loadWorker(options);
	let done;
	worker.listeners.install({ waitUntil: (promise) => { done = promise; } });
	await done;
	return worker;
}

function userCaches(worker) {
	return [...worker.stores.keys()].filter((name) => name.startsWith("mf-user-"));
}

function cachedPaths(worker, name) {
	return [...(worker.stores.get(name)?.entries.keys() ?? [])].map((url) => new URL(url).pathname + new URL(url).search);
}

async function message(worker, data, ports = []) {
	let done;
	worker.listeners.message({ data, ports, waitUntil: (promise) => { done = promise; } });
	await done;
}

/** Posts a message with a reply port, as app.js does, and returns what the worker answered on it. */
async function ask(worker, data) {
	const answers = [];
	await message(worker, data, [{ postMessage: (answer) => answers.push(answer) }]);
	return answers;
}

test("the worker precaches the versioned v2 assets named in its own URL", async () => {
	const worker = await installed();
	assert.deepEqual(worker.imported, ["/v2-assets/offline.js?v=7"]);
	assert.ok(worker.opened.includes("mf-static-7-2.0.11"));
	const keys = cachedPaths(worker, "mf-static-7-2.0.11").sort();
	assert.deepEqual(keys, ["/favicon.ico", "/icon-192.png", "/v2-assets/app.css?v=7", "/v2-assets/app.js?v=7", "/v2-assets/htmx.min.js?v=2.0.11", "/v2-assets/offline.html", "/v2-assets/offline.js?v=7"]);

	let done;
	worker.listeners.activate({ waitUntil: (promise) => { done = promise; } });
	await done;
	assert.deepEqual(worker.deleted, ["mf-static-6-2.0.11"], "only older static caches are dropped");
});

test("only full-document v2 navigations, mail bodies and attachments are handled; partials and JSON go straight to the network", async () => {
	const worker = await installed();
	assert.ok(dispatchFetch(worker, "/v2/inbox"), "page navigation");
	assert.ok(dispatchFetch(worker, "/v2/inbox/msg_1?i=2"), "thread navigation");
	assert.ok(dispatchFetch(worker, "/v2/body/msg_1", xhr), "mail body, loaded by htmx");
	assert.ok(dispatchFetch(worker, "/api/messages/msg_1/attachments/att_1?download=1", { mode: "no-cors", destination: "image" }), "attachment");
	assert.equal(dispatchFetch(worker, "/v2/inbox", { mode: "cors", destination: "" }), null, "htmx XHR");
	assert.equal(dispatchFetch(worker, "/v2/inbox", { headers: { "HX-Request": "true" } }), null, "htmx header");
	assert.equal(dispatchFetch(worker, "/v2/poll?path=%2Fv2%2Finbox", xhr), null, "poll");
	assert.equal(dispatchFetch(worker, "/v2/compose/new", xhr), null, "docked composer fragment");
	assert.equal(dispatchFetch(worker, "/v2/contacts?q=a", { mode: "cors", destination: "", headers: { Accept: "application/json" } }), null, "contacts JSON");
	assert.equal(dispatchFetch(worker, "/v2/inbox", { headers: { Accept: "application/json" } }), null, "JSON accept");
	assert.equal(dispatchFetch(worker, "/v2/act", { method: "POST" }), null, "POST action");
	assert.equal(dispatchFetch(worker, "/v2/body/msg_1", { ...xhr, method: "POST" }), null, "POST to a body URL");
	assert.equal(dispatchFetch(worker, "/inbox"), null, "classic page");
	assert.equal(dispatchFetch(worker, "/api/messages/msg_1"), null, "other API");
	assert.equal(dispatchFetch(worker, "https://other.example.com/v2/inbox"), null, "other origin");
});

test("pages come from the network while online, and the offline page stands in when nothing was cached", async () => {
	const online = await installed();
	assert.equal(await (await dispatchFetch(online, "/v2/inbox")).text(), "network https://mail.example.com/v2/inbox");

	const offline = await installed({ online: false });
	assert.match(await (await dispatchFetch(offline, "/v2/inbox")).text(), /^cached https:\/\/mail\.example\.com\/v2-assets\/offline\.html$/);
	assert.match(await (await dispatchFetch(offline, "/v2-assets/app.js?v=7", { mode: "no-cors", destination: "script" })).text(), /cached/);
});

test("the offline page is served as a fresh response even when its precached copy was redirected", async () => {
	const worker = await installed({ online: false });
	// Workers static assets answer /v2-assets/offline.html with a 307 to /v2-assets/offline.
	const cache = worker.stores.get("mf-static-7-2.0.11");
	const redirected = new Response("<h1>You're offline</h1>", { headers: { "Content-Type": "text/html" } });
	Object.defineProperty(redirected, "redirected", { value: true });
	cache.entries.set(`${ORIGIN}/v2-assets/offline.html`, { clone: () => redirected });
	const page = await dispatchFetch(worker, "/v2/sent");
	assert.equal(page.redirected, false, "a navigation rejects a redirected response");
	assert.equal(page.status, 200);
	assert.equal(await page.text(), "<h1>You're offline</h1>");
});

test("a signed-in page is cached for its user and served, marked with its age, when the network fails", async () => {
	const worker = await installed({ respond: (request) => served(doc("usr_a", new URL(request.url ?? request).pathname)) });
	const live = await dispatchFetch(worker, "/v2/inbox");
	assert.match(await live.text(), /data-user="usr_a"><main id="main">\/v2\/inbox/);
	await worker.idle();
	assert.deepEqual(userCaches(worker), ["mf-user-usr_a"]);
	assert.deepEqual(cachedPaths(worker, "mf-user-usr_a"), ["/v2/inbox"]);

	worker.network.online = false;
	const text = await (await dispatchFetch(worker, "/v2/inbox")).text();
	assert.match(text, /<body data-cached-at="\d{13}" hx-boost="true"/);
	assert.match(text, /\/v2\/inbox<\/main>/);
	assert.match(await (await dispatchFetch(worker, "/v2/sent")).text(), /^cached .*offline\.html$/, "a page never visited is not invented");
});

test("only full 200 documents that name a signed-in user are cached", async () => {
	const cases = [
		["no data-user (signed out, or not a v2 page)", served("<!doctype html><html><body><main>login</main></body></html>")],
		["a 404 page", served(doc("usr_a"), { status: 404 })],
		["a redirected response", served(doc("usr_a"), { redirected: true })],
		["a fragment", served(`<div data-user="usr_a"></div>`)],
	];
	for (const [label, response] of cases) {
		const worker = await installed({ respond: () => response });
		await dispatchFetch(worker, "/v2/inbox");
		await worker.idle();
		assert.deepEqual(userCaches(worker), [], label);
	}
	const action = await installed({ respond: () => served(doc("usr_a")) });
	await dispatchFetch(action, "/v2/compose/new");
	await action.idle();
	assert.deepEqual(userCaches(action), [], "action routes are never pages");
});

test("a second user on the same browser drops the first user's cache before anything of theirs is stored", async () => {
	let user = "usr_a";
	const worker = await installed({ respond: (request) => served(doc(user, new URL(request.url).pathname)) });
	await dispatchFetch(worker, "/v2/inbox");
	await dispatchFetch(worker, "/v2/inbox/msg_secret");
	await worker.idle();
	assert.deepEqual(cachedPaths(worker, "mf-user-usr_a"), ["/v2/inbox", "/v2/inbox/msg_secret"]);

	user = "usr_b";
	await dispatchFetch(worker, "/v2/inbox");
	await worker.idle();
	assert.deepEqual(userCaches(worker), ["mf-user-usr_b"]);

	worker.network.online = false;
	assert.match(await (await dispatchFetch(worker, "/v2/inbox/msg_secret")).text(), /offline\.html/, "the first user's thread is gone");
	assert.match(await (await dispatchFetch(worker, "/v2/inbox")).text(), /data-user="usr_b"/);
});

test("boosted pages handed over by the page are stored only for the user they name", async () => {
	const worker = await installed();
	await message(worker, { type: "store-page", url: `${ORIGIN}/v2/archive`, html: doc("usr_a", "archive") });
	await message(worker, { type: "store-page", url: `${ORIGIN}/v2/act`, html: doc("usr_a", "act") });
	await message(worker, { type: "store-page", url: "https://evil.example/v2/inbox", html: doc("usr_a") });
	await message(worker, { type: "store-page", url: `${ORIGIN}/v2/spam`, html: "<!doctype html><body>no user</body>" });
	assert.deepEqual(cachedPaths(worker, "mf-user-usr_a"), ["/v2/archive"]);

	worker.network.online = false;
	assert.match(await (await dispatchFetch(worker, "/v2/archive")).text(), /data-cached-at=.*archive<\/main>/);
});

test("warming the composer answers true only once the page is stored, so the page can ask again otherwise", async () => {
	const worker = await installed({ respond: (request) => served(doc("usr_a", new URL(request.url ?? request).pathname)) });
	assert.deepEqual(await ask(worker, { type: "warm", url: "/v2/compose" }), [true]);
	assert.deepEqual(cachedPaths(worker, "mf-user-usr_a"), ["/v2/compose"]);
	worker.network.online = false;
	assert.match(await (await dispatchFetch(worker, "/v2/compose")).text(), /data-cached-at=.*\/v2\/compose<\/main>/);

	const signedOut = await installed({ respond: () => served("", { redirected: true }) });
	assert.deepEqual(await ask(signedOut, { type: "warm", url: "/v2/compose" }), [false], "a redirect to sign-in is not stored");
	const offline = await installed({ online: false });
	assert.deepEqual(await ask(offline, { type: "warm", url: "/v2/compose" }), [false], "a failed fetch answers too");
	const noUser = await installed({ respond: () => served("<!doctype html><body>no user</body>") });
	assert.deepEqual(await ask(noUser, { type: "warm", url: "/v2/compose" }), [false], "a page naming no user is not stored");
	assert.deepEqual(await ask(worker, { type: "warm", url: "/v2/act" }), [false], "only pages are warmed");
	assert.deepEqual(await ask(worker, { type: "warm", url: "https://evil.example/v2/compose" }), [false]);
	await message(worker, { type: "warm", url: "/v2/compose" });
});

test("mail bodies are cached for the user named in their response and served offline", async () => {
	const worker = await installed({
		respond: () => served(`<div id="body-msg_1">hello</div>`, { headers: { "Content-Type": "text/html", "X-Mailflare-User": "usr_a", Vary: "HX-Request, Cookie" } }),
	});
	assert.equal(await (await dispatchFetch(worker, "/v2/body/msg_1", xhr)).text(), `<div id="body-msg_1">hello</div>`);
	await worker.idle();
	assert.deepEqual(cachedPaths(worker, "mf-user-usr_a"), ["/v2/body/msg_1"]);

	worker.network.online = false;
	assert.equal(await (await dispatchFetch(worker, "/v2/body/msg_1", xhr)).text(), `<div id="body-msg_1">hello</div>`);
	await assert.rejects(dispatchFetch(worker, "/v2/body/msg_2", xhr), /Failed to fetch/, "an unopened body fails like any request offline");

	const anonymous = await installed({ respond: () => served("<div>x</div>") });
	await dispatchFetch(anonymous, "/v2/body/msg_1", xhr);
	await anonymous.idle();
	assert.deepEqual(userCaches(anonymous), [], "a body without an owner is not kept");
});

test("attachments join the signed-in user's cache, within the size cap, and only once a user cache exists", async () => {
	let size = 1024;
	const worker = await installed({
		respond: (request) => new URL(typeof request === "string" ? request : request.url).pathname.startsWith("/api/")
			? served(new Uint8Array(size), { headers: { "Content-Type": "application/pdf", "Content-Length": String(size) } })
			: served(doc("usr_a")),
	});
	await dispatchFetch(worker, "/api/messages/msg_1/attachments/att_1?download=1", { mode: "no-cors", destination: "" });
	await worker.idle();
	assert.deepEqual(userCaches(worker), [], "no user known yet");

	await dispatchFetch(worker, "/v2/inbox");
	await worker.idle();
	await dispatchFetch(worker, "/api/messages/msg_1/attachments/att_1?download=1", { mode: "no-cors", destination: "" });
	size = 11 * 1024 * 1024;
	await dispatchFetch(worker, "/api/messages/msg_1/attachments/att_big", { mode: "no-cors", destination: "" });
	await worker.idle();
	assert.deepEqual(cachedPaths(worker, "mf-user-usr_a"), ["/v2/inbox", "/api/messages/msg_1/attachments/att_1?download=1"]);

	// Downloads are navigations the worker never sees; the page asks it to keep a copy.
	size = 2048;
	await message(worker, { type: "keep-file", url: `${ORIGIN}/api/messages/msg_2/attachments/att_2?download=1` });
	await message(worker, { type: "keep-file", url: `${ORIGIN}/v2/inbox` });
	await message(worker, { type: "keep-file", url: "https://evil.example/api/messages/msg_3/attachments/att_3" });
	assert.deepEqual(cachedPaths(worker, "mf-user-usr_a"), ["/v2/inbox", "/api/messages/msg_1/attachments/att_1?download=1", "/api/messages/msg_2/attachments/att_2?download=1"]);

	worker.network.online = false;
	const file = await dispatchFetch(worker, "/api/messages/msg_1/attachments/att_1", { mode: "no-cors", destination: "image" });
	assert.equal((await file.arrayBuffer()).byteLength, 1024, "an inline image finds the downloaded file");
	const kept = await dispatchFetch(worker, "/api/messages/msg_2/attachments/att_2?download=1", { mode: "cors", destination: "" });
	assert.equal((await kept.arrayBuffer()).byteLength, 2048, "the page's offline download finds the kept copy");
});

test("each kind of cached entry keeps only its most recent ones", async () => {
	const worker = await installed({ respond: () => served(doc("usr_a")) });
	for (let index = 0; index < 45; index += 1) await dispatchFetch(worker, `/v2/inbox/msg_${index}`);
	await worker.idle();
	const pages = cachedPaths(worker, "mf-user-usr_a");
	assert.equal(pages.length, 40);
	assert.equal(pages[0], "/v2/inbox/msg_5");
	await dispatchFetch(worker, "/v2/inbox/msg_5");
	await dispatchFetch(worker, "/v2/inbox/msg_new");
	await worker.idle();
	const after = cachedPaths(worker, "mf-user-usr_a");
	assert.ok(after.includes("/v2/inbox/msg_5"), "a page visited again is fresh again");
	assert.ok(!after.includes("/v2/inbox/msg_6"), "the oldest goes");
});

test("a push shows the licensed custom icon the server sends, and the packaged icon otherwise", async () => {
	const worker = loadWorker();
	const shown = [];
	worker.self.registration.showNotification = async (title, options) => { shown.push(options.icon); };
	const push = async (data) => {
		let done;
		worker.listeners.push({ data: { json: () => data }, waitUntil: (promise) => { done = promise; } });
		await done;
	};
	await push({ messageId: "m1", from: "a@b.c", subject: "Hi" });
	await push({ messageId: "m2", from: "a@b.c", subject: "Hi", icon: "/api/branding/icon/192?v=1760000000" });
	// Only the branding route is trusted as an icon source.
	await push({ messageId: "m3", from: "a@b.c", subject: "Hi", icon: "https://evil.example/x.png" });
	assert.deepEqual(shown, ["/icon-192.png", "/api/branding/icon/192?v=1760000000", "/icon-192.png"]);
});

/** Dispatches an extendable event; returns what the worker passed to waitUntil, or null if it stayed out of it. */
function fire(worker, type, event = {}) {
	let done = null;
	worker.listeners[type]({ ...event, waitUntil: (promise) => { done = promise; } });
	return done;
}

/** Values made in the sandbox have its prototypes; compare them as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** The outbox as an earlier page left it: `user` recorded in meta (as app.js does) and `entries` queued. */
function seedOutbox(worker, { user, entries }) {
	const stores = new Map([
		["outbox", { keyPath: "id", data: new Map(entries.map((entry) => [entry.id, entry])) }],
		["meta", { keyPath: undefined, data: new Map(user ? [["user", user]] : []) }],
	]);
	worker.databases.set("mailflare-offline", stores);
	return {
		ids: () => [...stores.get("outbox").data.keys()],
		user: () => stores.get("meta").data.get("user"),
	};
}

const queued = (id, kind, fields, extra = {}) => ({ id, kind, user: "usr_a", createdAt: Number(id.replace(/\D/g, "")), fields, ...extra });

/** A scripted server for replays: `routes[path]` answers (fields) with a response; every call is recorded. */
function replayServer(routes) {
	const calls = [];
	const respond = (path, init) => {
		const fields = Object.fromEntries([...init.body]);
		calls.push({ path, user: init.headers["X-Mailflare-User"], redirect: init.redirect, fields });
		return routes[path](fields);
	};
	return { calls, respond };
}

test("Background Sync replays the outbox in order for the user the page recorded, holding the outbox lock, and tells open pages", async () => {
	const server = replayServer({ "/v2/act": () => served("") });
	const worker = await installed({ respond: server.respond });
	const outbox = seedOutbox(worker, {
		user: "usr_a",
		entries: [
			queued("e2", "act", [["ids", "m2"], ["action", "trash"]]),
			queued("e1", "act", [["ids", "m1"], ["action", "archive"]]),
			queued("e3", "act", [["ids", "m3"], ["action", "archive"]], { user: "usr_b" }),
		],
	});

	assert.equal(fire(worker, "sync", { tag: "something-else" }), null, "another tag is not the outbox's");
	await fire(worker, "sync", { tag: "mf-outbox" });
	assert.deepEqual(server.calls.map((call) => [call.path, call.fields.ids, call.user, call.redirect]), [
		["/v2/act", "m1", "usr_a", "manual"],
		["/v2/act", "m2", "usr_a", "manual"],
	], "oldest first, as the user who queued them");
	assert.deepEqual(plain(worker.locks), [{ name: "mf-outbox", held: false }], "a page draining at the same time waits for the lock");
	assert.deepEqual(outbox.ids(), ["e3"], "another user's entry is never sent");
	assert.deepEqual(plain(worker.posted), [{ type: "outbox-drained", result: { sent: 2, dropped: 0, remaining: 0, signedOut: false, unreachable: false } }]);
});

test("Background Sync does nothing until a page has recorded whose outbox it is", async () => {
	const server = replayServer({ "/v2/act": () => served("") });
	const worker = await installed({ respond: server.respond });
	const outbox = seedOutbox(worker, { user: null, entries: [queued("e1", "act", [["ids", "m1"], ["action", "archive"]])] });
	await fire(worker, "sync", { tag: "mf-outbox" });
	assert.deepEqual(server.calls, []);
	assert.deepEqual(outbox.ids(), ["e1"]);
	assert.deepEqual(worker.posted, []);
});

test("Background Sync that cannot reach the server keeps the entries and fails, so the browser tries again later", async () => {
	const server = replayServer({ "/v2/act": () => served("") });
	const worker = await installed({ online: false, respond: server.respond });
	const outbox = seedOutbox(worker, { user: "usr_a", entries: [queued("e1", "act", [["ids", "m1"], ["action", "archive"]])] });
	await assert.rejects(fire(worker, "sync", { tag: "mf-outbox" }), /Outbox not drained/);
	assert.deepEqual(outbox.ids(), ["e1"]);
	assert.deepEqual(plain(worker.posted), [{ type: "outbox-drained", result: { sent: 0, dropped: 0, remaining: 1, signedOut: false, unreachable: true } }], "open pages still show 1 change waiting, and know the server was out of reach");

	worker.network.online = true;
	await fire(worker, "sync", { tag: "mf-outbox" });
	assert.deepEqual(server.calls.map((call) => call.fields.ids), ["m1"]);
	assert.deepEqual(outbox.ids(), []);
	assert.deepEqual(plain(worker.posted.at(-1)), { type: "outbox-drained", result: { sent: 1, dropped: 0, remaining: 0, signedOut: false, unreachable: false } });
});

test("Background Sync tells open pages why an entry was refused, and which server draft a queued send saved", async () => {
	const server = replayServer({
		"/v2/act": () => served("Pick a time in the future.", { status: 422, headers: { "Content-Type": "text/plain" } }),
		"/v2/draft": (fields) => served(JSON.stringify({ draftId: fields.draftId || "msg_new" }), { headers: { "Content-Type": "application/json" } }),
		"/v2/send": () => served("", { status: 303, headers: { Location: "/v2/inbox" } }),
	});
	const worker = await installed({ respond: server.respond });
	const outbox = seedOutbox(worker, {
		user: "usr_a",
		entries: [
			queued("e1", "act", [["ids", "m1"], ["snooze", "custom"], ["snoozeAt", "2020-01-01T08:00"]]),
			queued("e2", "send", [["to", "a@b.c"], ["subject", "Hi"], ["draftId", ""]], { key: "k1" }),
		],
	});
	await fire(worker, "sync", { tag: "mf-outbox" });
	assert.deepEqual(server.calls.map((call) => [call.path, call.fields.draftId]), [["/v2/act", undefined], ["/v2/draft", ""], ["/v2/send", "msg_new"]]);
	assert.deepEqual(plain(worker.posted), [
		{ type: "outbox-dropped", message: "Pick a time in the future." },
		{ type: "outbox-draft", key: "k1", draftId: "msg_new" },
		{ type: "outbox-drained", result: { sent: 1, dropped: 1, remaining: 0, signedOut: false, unreachable: false } },
	]);
	assert.deepEqual(outbox.ids(), []);
});

test("Background Sync that finds the user signed out drops every user's cached mail and the whole outbox, and does not retry", async () => {
	const server = replayServer({ "/v2/act": () => served("", { status: 401 }) });
	const worker = await installed({ respond: (request, init) => (init?.method === "POST" ? server.respond(request, init) : served(doc("usr_a"))) });
	await dispatchFetch(worker, "/v2/inbox");
	await worker.idle();
	assert.deepEqual(userCaches(worker), ["mf-user-usr_a"]);
	const outbox = seedOutbox(worker, {
		user: "usr_a",
		entries: [queued("e1", "act", [["ids", "m1"], ["action", "archive"]]), queued("e2", "act", [["ids", "m2"], ["action", "archive"]])],
	});
	await fire(worker, "sync", { tag: "mf-outbox" });
	assert.equal(server.calls.length, 1, "the replay stops at the first 401");
	assert.deepEqual(userCaches(worker), []);
	assert.deepEqual(outbox.ids(), []);
	assert.equal(outbox.user(), null, "the next page to load records its own user");
	assert.deepEqual(plain(worker.posted), [{ type: "outbox-drained", result: { sent: 0, dropped: 0, remaining: 2, signedOut: true, unreachable: false } }], "pages purge their copies too");
});

const KEY = new Uint8Array([4, ...Array.from({ length: 64 }, (_, index) => (index * 37 + 250) % 256)]);
const base64Url = (bytes) => Buffer.from(bytes).toString("base64url");

/** A PushSubscription as the browser hands it over. */
function subscriptionFor(endpoint, key = KEY) {
	return {
		endpoint,
		options: { applicationServerKey: key ? new Uint8Array(key).buffer : null },
		toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: `p256dh-${endpoint}`, auth: "auth" } }),
	};
}

/** A server for /v2/push/*: `answers[path]` gives the status; every POST body is recorded. */
function pushServer(answers = {}) {
	const posts = [];
	const respond = (path, init = {}) => {
		const status = answers[path] ?? 200;
		if (init.method === "POST") posts.push([path, JSON.parse(init.body)]);
		else if (path === "/v2/push/key") return served(JSON.stringify(status === 200 ? { publicKey: base64Url(KEY) } : { error: "Sign in" }), { status, headers: { "Content-Type": "application/json" } });
		return served("{}", { status, headers: { "Content-Type": "application/json" } });
	};
	return { posts, respond };
}

test("a rotated push subscription is registered with the server before the old endpoint is dropped", async () => {
	const server = pushServer();
	const worker = loadWorker({ respond: server.respond });
	await fire(worker, "pushsubscriptionchange", { oldSubscription: subscriptionFor("https://push.example/old"), newSubscription: subscriptionFor("https://push.example/new") });
	assert.deepEqual(server.posts, [
		["/v2/push/subscribe", { endpoint: "https://push.example/new", expirationTime: null, keys: { p256dh: "p256dh-https://push.example/new", auth: "auth" }, applicationServerKey: base64Url(KEY) }],
		["/v2/push/unsubscribe", { endpoint: "https://push.example/old" }],
	], "the server learns which VAPID key the new endpoint belongs to");

	const same = pushServer();
	const unchanged = loadWorker({ respond: same.respond });
	await fire(unchanged, "pushsubscriptionchange", { oldSubscription: subscriptionFor("https://push.example/a"), newSubscription: subscriptionFor("https://push.example/a") });
	assert.deepEqual(same.posts.map(([path]) => path), ["/v2/push/subscribe"], "the same endpoint is never unsubscribed");

	const noOld = pushServer();
	const first = loadWorker({ respond: noOld.respond });
	await fire(first, "pushsubscriptionchange", { newSubscription: subscriptionFor("https://push.example/b", null) });
	assert.deepEqual(noOld.posts, [["/v2/push/subscribe", { endpoint: "https://push.example/b", expirationTime: null, keys: { p256dh: "p256dh-https://push.example/b", auth: "auth" } }]], "no key on the subscription, none sent");
});

test("a rotated push subscription the server refuses keeps the old endpoint registered; a failed unsubscribe is ignored", async () => {
	const refused = pushServer({ "/v2/push/subscribe": 500 });
	const worker = loadWorker({ respond: refused.respond });
	await assert.rejects(fire(worker, "pushsubscriptionchange", { oldSubscription: subscriptionFor("https://push.example/old"), newSubscription: subscriptionFor("https://push.example/new") }), /\/v2\/push\/subscribe answered 500/);
	assert.deepEqual(refused.posts.map(([path]) => path), ["/v2/push/subscribe"]);

	const flaky = pushServer({ "/v2/push/unsubscribe": 503 });
	const other = loadWorker({ respond: flaky.respond });
	await fire(other, "pushsubscriptionchange", { oldSubscription: subscriptionFor("https://push.example/old"), newSubscription: subscriptionFor("https://push.example/new") });
	assert.deepEqual(flaky.posts.map(([path]) => path), ["/v2/push/subscribe", "/v2/push/unsubscribe"]);
});

test("an expired push subscription with no replacement subscribes again with the server's current key", async () => {
	const server = pushServer();
	const worker = loadWorker({ respond: server.respond });
	const subscribed = [];
	worker.self.registration.pushManager = {
		subscribe: async (options) => {
			subscribed.push({ userVisibleOnly: options.userVisibleOnly, key: Array.from(options.applicationServerKey) });
			return subscriptionFor("https://push.example/again", options.applicationServerKey);
		},
	};
	await fire(worker, "pushsubscriptionchange", { oldSubscription: subscriptionFor("https://push.example/expired") });
	assert.deepEqual(subscribed, [{ userVisibleOnly: true, key: Array.from(KEY) }], "the base64url key from /v2/push/key, decoded");
	assert.deepEqual(server.posts.map(([path, body]) => [path, body.endpoint, body.applicationServerKey]), [
		["/v2/push/subscribe", "https://push.example/again", base64Url(KEY)],
		["/v2/push/unsubscribe", "https://push.example/expired", undefined],
	]);

	// Signed out (or push turned off on the server): no key, so nothing is subscribed or sent.
	const signedOut = pushServer({ "/v2/push/key": 401 });
	const gone = loadWorker({ respond: signedOut.respond });
	gone.self.registration.pushManager = { subscribe: async () => assert.fail("subscribed without a key") };
	await fire(gone, "pushsubscriptionchange", { oldSubscription: subscriptionFor("https://push.example/expired") });
	assert.deepEqual(signedOut.posts, []);
});
