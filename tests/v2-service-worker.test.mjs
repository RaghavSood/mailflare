import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "public/sw.js"), "utf8");

/** Loads public/sw.js in a sandbox with fake caches, returning its listeners and the cache log. */
function loadWorker({ online = true } = {}) {
	const listeners = {};
	const stored = new Map();
	const opened = [];
	const deleted = [];
	const cacheFor = (name) => ({
		addAll: async (requests) => {
			for (const request of requests) stored.set(`${name} ${new URL(request.url, "https://mail.example.com").pathname}${new URL(request.url, "https://mail.example.com").search}`, new Response(`cached ${request.url}`));
		},
	});
	const self = {
		location: new URL("https://mail.example.com/sw.js?v=7&htmx=2.0.11"),
		registration: {},
		clients: { claim: async () => {} },
		skipWaiting: async () => {},
		addEventListener: (type, fn) => { listeners[type] = fn; },
	};
	const caches = {
		open: async (name) => { opened.push(name); return cacheFor(name); },
		keys: async () => ["mf-static-6-2.0.11", "mf-static-7-2.0.11", "other-cache"],
		delete: async (name) => { deleted.push(name); return true; },
		match: async (request, options = {}) => {
			const url = new URL(typeof request === "string" ? request : request.url, "https://mail.example.com");
			return stored.get(`${options.cacheName} ${url.pathname}${url.search}`)?.clone();
		},
	};
	const fetch = async (request) => {
		if (!online) throw new TypeError("Failed to fetch");
		return new Response(`network ${request.url}`);
	};
	// Workers resolve relative URLs against their own location; Node's Request does not.
	const WorkerRequest = class extends Request {
		constructor(input, init) {
			super(typeof input === "string" ? new URL(input, self.location.href) : input, init);
		}
	};
	vm.runInNewContext(source, { self, caches, fetch, Request: WorkerRequest, Response, URL, Promise, console });
	return { listeners, stored, opened, deleted };
}

/** Dispatches a fetch event and returns the promised response, or null when the worker stays out of it. */
function dispatchFetch(worker, url, init = {}) {
	const request = new Request(new URL(url, "https://mail.example.com"), { headers: init.headers });
	const fake = {
		method: init.method ?? "GET",
		mode: init.mode ?? "navigate",
		destination: init.destination ?? "document",
		headers: request.headers,
		url: request.url,
	};
	let responded = null;
	worker.listeners.fetch({ request: fake, respondWith: (value) => { responded = Promise.resolve(value); } });
	return responded;
}

async function installed(options) {
	const worker = loadWorker(options);
	let done;
	worker.listeners.install({ waitUntil: (promise) => { done = promise; } });
	await done;
	return worker;
}

test("the worker precaches the versioned v2 assets named in its own URL", async () => {
	const worker = await installed();
	assert.deepEqual(worker.opened, ["mf-static-7-2.0.11"]);
	const keys = [...worker.stored.keys()].map((key) => key.split(" ")[1]).sort();
	assert.deepEqual(keys, ["/favicon.ico", "/icon-192.png", "/v2-assets/app.css?v=7", "/v2-assets/app.js?v=7", "/v2-assets/htmx.min.js?v=2.0.11", "/v2-assets/offline.html"]);

	let done;
	worker.listeners.activate({ waitUntil: (promise) => { done = promise; } });
	await done;
	assert.deepEqual(worker.deleted, ["mf-static-6-2.0.11"], "only older static caches are dropped");
});

test("only full-document v2 navigations are handled; partials, frames and JSON go straight to the network", async () => {
	const worker = await installed();
	assert.ok(dispatchFetch(worker, "/v2/inbox"), "page navigation");
	assert.ok(dispatchFetch(worker, "/v2/inbox/msg_1?i=2"), "thread navigation");
	assert.equal(dispatchFetch(worker, "/v2/inbox", { mode: "cors", destination: "" }), null, "htmx XHR");
	assert.equal(dispatchFetch(worker, "/v2/inbox", { headers: { "HX-Request": "true" } }), null, "htmx header");
	assert.equal(dispatchFetch(worker, "/v2/body/msg_1", { destination: "iframe" }), null, "mail frame");
	assert.equal(dispatchFetch(worker, "/v2/contacts?q=a", { mode: "cors", destination: "", headers: { Accept: "application/json" } }), null, "contacts JSON");
	assert.equal(dispatchFetch(worker, "/v2/inbox", { headers: { Accept: "application/json" } }), null, "JSON accept");
	assert.equal(dispatchFetch(worker, "/v2/act", { method: "POST" }), null, "POST action");
	assert.equal(dispatchFetch(worker, "/inbox"), null, "classic page");
	assert.equal(dispatchFetch(worker, "https://other.example.com/v2/inbox"), null, "other origin");
});

test("pages are never served from cache online, and fall back to the offline page when the network is gone", async () => {
	const online = await installed();
	assert.equal(await (await dispatchFetch(online, "/v2/inbox")).text(), "network https://mail.example.com/v2/inbox");

	const offline = await installed({ online: false });
	assert.match(await (await dispatchFetch(offline, "/v2/inbox")).text(), /^cached https:\/\/mail\.example\.com\/v2-assets\/offline\.html$/);
	assert.match(await (await dispatchFetch(offline, "/v2-assets/app.js?v=7", { mode: "no-cors", destination: "script" })).text(), /cached/);
});
