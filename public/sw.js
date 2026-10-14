/* Mailflare v2 service worker, registered by app.js with scope /v2/.
   The registration URL carries the asset versions (?v=<ASSET_VERSION>&htmx=<version>),
   so bumping ASSET_VERSION installs a new worker that precaches the new assets
   and drops the old ones. Pages are network-first; a navigation that cannot
   reach the server gets the offline page. Only static assets are cached here:
   v2 pages hold mail, so caching them needs the per-user keying that comes with
   offline reading. */
"use strict";

const params = new URL(self.location.href).searchParams;
const ASSET_VERSION = params.get("v") || "0";
const HTMX_VERSION = params.get("htmx") || "0";
const STATIC_CACHE = `mf-static-${ASSET_VERSION}-${HTMX_VERSION}`;
const OFFLINE_URL = "/v2-assets/offline.html";
const PRECACHE = [
	`/v2-assets/app.css?v=${ASSET_VERSION}`,
	`/v2-assets/app.js?v=${ASSET_VERSION}`,
	`/v2-assets/htmx.min.js?v=${HTMX_VERSION}`,
	OFFLINE_URL,
	"/icon-192.png",
	"/favicon.ico",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(STATIC_CACHE)
			.then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" }))))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		const names = await caches.keys();
		await Promise.all(names.filter((name) => name.startsWith("mf-static-") && name !== STATIC_CACHE).map((name) => caches.delete(name)));
		await self.clients.claim();
	})());
});

/** Full-document navigations to v2 pages; never htmx partials, frames or JSON. */
function isPageNavigation(request, url) {
	if (request.method !== "GET" || request.mode !== "navigate" || request.destination !== "document") return false;
	if (request.headers.has("HX-Request")) return false;
	if ((request.headers.get("Accept") || "").includes("application/json")) return false;
	return url.pathname === "/v2" || url.pathname.startsWith("/v2/");
}

function isPrecached(url) {
	return url.pathname.startsWith("/v2-assets/") || url.pathname === "/icon-192.png" || url.pathname === "/favicon.ico";
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (isPageNavigation(request, url)) {
		event.respondWith((async () => {
			try {
				return await fetch(request);
			} catch {
				const offline = await caches.match(OFFLINE_URL, { cacheName: STATIC_CACHE });
				return offline || new Response("You're offline.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
			}
		})());
		return;
	}

	if (request.method === "GET" && isPrecached(url)) {
		// Versioned URLs never change, so the precache is authoritative; anything
		// else falls through to the network untouched.
		event.respondWith(caches.match(request, { cacheName: STATIC_CACHE }).then((hit) => hit || fetch(request)));
	}
});
