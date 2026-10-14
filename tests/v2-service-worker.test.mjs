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
	const self = {
		location: new URL(`${ORIGIN}/sw.js?v=7&htmx=2.0.11`),
		registration: {},
		clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (message) => posted.push(message) }] },
		skipWaiting: async () => {},
		addEventListener: (type, fn) => {
			listeners[type] = fn;
		},
		caches,
	};
	const fetch = async (request) => {
		if (!network.online) throw new TypeError("Failed to fetch");
		return network.respond(request);
	};
	// Workers resolve relative URLs against their own location; Node's Request does not.
	const WorkerRequest = class extends Request {
		constructor(input, init) {
			super(typeof input === "string" ? new URL(input, self.location.href) : input, init);
		}
	};
	const imported = [];
	const context = vm.createContext({ self, caches, fetch, Request: WorkerRequest, Response, Headers, URL, Promise, FormData, console });
	context.importScripts = (url) => {
		imported.push(url);
		vm.runInContext(offlineSource, context);
	};
	vm.runInContext(source, context);
	const worker = { listeners, stores, opened, deleted, waits, network, imported, posted, self };
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

async function message(worker, data) {
	let done;
	worker.listeners.message({ data, waitUntil: (promise) => { done = promise; } });
	await done;
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
	const worker = await installed({ respond: (request) => served(doc("usr_a", new URL(request.url).pathname)) });
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
