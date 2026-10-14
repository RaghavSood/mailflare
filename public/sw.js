/* Mailflare v2 service worker, registered by app.js with scope /v2/.
   The registration URL carries the asset versions (?v=<ASSET_VERSION>&htmx=<version>),
   so bumping ASSET_VERSION installs a new worker that precaches the new assets
   and drops the old ones. Pages are network-first; a navigation that cannot
   reach the server gets the user's cached copy (see "offline reading") or the
   offline page.
   It also shows new-mail push notifications (the server decides whether to
   send one, so every push shows a notification, as Chrome requires) and
   keeps the push subscription registered with the server. */
"use strict";

const params = new URL(self.location.href).searchParams;
const ASSET_VERSION = params.get("v") || "0";
const HTMX_VERSION = params.get("htmx") || "0";
const STATIC_CACHE = `mf-static-${ASSET_VERSION}-${HTMX_VERSION}`;
const OFFLINE_URL = "/v2-assets/offline.html";
importScripts(`/v2-assets/offline.js?v=${ASSET_VERSION}`);
const PRECACHE = [
	`/v2-assets/app.css?v=${ASSET_VERSION}`,
	`/v2-assets/app.js?v=${ASSET_VERSION}`,
	`/v2-assets/htmx.min.js?v=${HTMX_VERSION}`,
	`/v2-assets/offline.js?v=${ASSET_VERSION}`,
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
		event.respondWith(pageFromNetworkOrCache(event, request, url));
		return;
	}

	if (request.method === "GET" && handleMailFetch(event, request, url)) return;

	if (request.method === "GET" && isPrecached(url)) {
		// Versioned URLs never change, so the precache is authoritative; anything
		// else falls through to the network untouched.
		event.respondWith(caches.match(request, { cacheName: STATIC_CACHE }).then((hit) => hit || fetch(request)));
	}
});

/* ---------- push notifications ---------- */

const INBOX_URL = "/v2/inbox";

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		/* Not JSON: still show something, as userVisibleOnly requires. */
	}
	const title = data.fromName || data.from || "New mail";
	const url = data.messageId ? `${INBOX_URL}/${encodeURIComponent(data.messageId)}` : INBOX_URL;
	event.waitUntil(self.registration.showNotification(title, {
		body: data.subject || "(no subject)",
		tag: data.messageId || undefined,
		icon: typeof data.icon === "string" && data.icon.startsWith("/api/branding/icon/") ? data.icon : "/icon-192.png",
		data: { url },
	}));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = new URL((event.notification.data && event.notification.data.url) || INBOX_URL, self.location.origin).href;
	event.waitUntil((async () => {
		const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		const open = windows.find((client) => new URL(client.url).pathname.startsWith("/v2/"));
		if (!open) {
			await self.clients.openWindow(target);
			return;
		}
		const focused = await open.focus().catch(() => open);
		// app.js navigates in place (keeping the composer dock); a full navigation is the fallback.
		try {
			focused.postMessage({ type: "mf:open", url: target });
		} catch {
			await focused.navigate(target).catch(() => self.clients.openWindow(target));
		}
	})());
});

function base64UrlToBytes(value) {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function postSubscription(path, body) {
	const response = await fetch(path, {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${path} answered ${response.status}`);
}

// The push service rotated or expired the subscription: subscribe again with
// the server's current key and swap the endpoint the server holds.
self.addEventListener("pushsubscriptionchange", (event) => {
	event.waitUntil((async () => {
		const previous = event.oldSubscription;
		let subscription = event.newSubscription;
		if (!subscription) {
			const response = await fetch("/v2/push/key", { credentials: "same-origin", headers: { Accept: "application/json" } });
			const { publicKey } = response.ok ? await response.json() : {};
			if (!publicKey) return;
			subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
		}
		const key = subscription.options && subscription.options.applicationServerKey;
		const applicationServerKey = key ? btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : undefined;
		await postSubscription("/v2/push/subscribe", { ...subscription.toJSON(), applicationServerKey });
		if (previous && previous.endpoint !== subscription.endpoint) await postSubscription("/v2/push/unsubscribe", { endpoint: previous.endpoint }).catch(() => {});
	})());
});

/* ---------- offline reading ----------
   Pages, mail bodies and attachments the user has seen are kept in one cache
   per user (mf-user-<id>), at most one of which exists: storing anything for a
   user drops every other user's cache. A page is stored only if it is a full
   200 document, not redirected, whose <body data-user> names its owner, which
   only a signed-in render carries. Pages are network-first; the cached copy is
   served only when the network fails, marked with data-cached-at. Boosted
   (htmx) navigations never reach this handler; app.js hands their documents
   over with a "store-page" message instead, and goes to a full navigation
   while offline. */

const Offline = self.MailflareOffline;

async function serveOffline(url) {
	const cacheName = await currentUserCache();
	const hit = cacheName ? await caches.match(url.href, { cacheName, ignoreVary: true }) : null;
	if (hit) {
		const cachedAt = Number(hit.headers.get("X-Mailflare-Cached-At")) || 0;
		const headers = new Headers(hit.headers);
		headers.delete("Content-Length");
		return new Response(Offline.markCached(await hit.text(), cachedAt), { status: 200, headers });
	}
	const offline = await caches.match(OFFLINE_URL, { cacheName: STATIC_CACHE });
	// Cloudflare's asset server redirects *.html to the extensionless URL, so the
	// precached copy is a redirected response, which a navigation refuses
	// (net::ERR_FAILED). A fresh Response carrying the same page is not.
	if (offline) return new Response(await offline.blob(), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
	return new Response("You're offline.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function pageFromNetworkOrCache(event, request, url) {
	let response;
	try {
		response = await fetch(request);
	} catch {
		return serveOffline(url);
	}
	if (Offline.cacheKind(url) === "page" && response.status === 200 && !response.redirected && response.type === "basic") {
		const copy = response.clone();
		event.waitUntil(copy.text().then((text) => storeDocument(url.href, text, copy.headers)).catch(() => {}));
	}
	return response;
}

/** The single user cache, if exactly one exists. */
async function currentUserCache() {
	const names = (await caches.keys()).filter(Offline.isUserCacheName);
	return names.length === 1 ? names[0] : null;
}

/** Make `user` the only user with a cache, and return that cache. */
async function cacheForUser(user) {
	const own = Offline.userCacheName(user);
	const names = await caches.keys();
	await Promise.all(names.filter((name) => Offline.isUserCacheName(name) && name !== own).map((name) => caches.delete(name)));
	return caches.open(own);
}

async function putTrimmed(cache, key, response, kind) {
	await cache.delete(key, { ignoreVary: true });
	await cache.put(key, response);
	const urls = (await cache.keys()).map((item) => item.url);
	await Promise.all(Offline.overLimit(urls, kind).map((old) => cache.delete(old, { ignoreVary: true })));
}

function storedHeaders(source) {
	const headers = new Headers();
	headers.set("Content-Type", source?.get?.("Content-Type") || "text/html; charset=utf-8");
	headers.set("X-Mailflare-Cached-At", String(Date.now()));
	return headers;
}

/** Store a rendered v2 page for the user it names; anything without an owner is not stored. */
async function storeDocument(href, text, headers) {
	const url = new URL(href);
	if (url.origin !== self.location.origin || Offline.cacheKind(url) !== "page") return false;
	const user = Offline.userFromHtml(text);
	if (!user || !/^\s*<!doctype html/i.test(text)) return false;
	const cache = await cacheForUser(user);
	await putTrimmed(cache, url.href, new Response(text, { status: 200, headers: storedHeaders(headers) }), "page");
	return true;
}

/**
 * Mail bodies (/v2/body/<id>, fetched by htmx when a collapsed message opens)
 * and attachments are cached as they are fetched, network-first. A body names
 * its owner in X-Mailflare-User; an attachment only joins an existing user
 * cache. Returns false when the request is not one of these.
 */
function handleMailFetch(event, request, url) {
	const kind = Offline.cacheKind(url);
	if (kind !== "body" && kind !== "file") return false;
	event.respondWith((async () => {
		let response;
		try {
			response = await fetch(request);
		} catch (error) {
			const cacheName = await currentUserCache();
			const hit = cacheName ? await caches.match(request, { cacheName, ignoreVary: true, ignoreSearch: kind === "file" }) : null;
			if (hit) return hit;
			throw error;
		}
		if (response.status === 200 && !response.redirected && response.type === "basic") {
			event.waitUntil(storeMail(url, kind, response.clone()).catch(() => {}));
		}
		return response;
	})());
	return true;
}

async function storeMail(url, kind, response) {
	let cache;
	if (kind === "body") {
		const user = response.headers.get("X-Mailflare-User");
		if (!user) return;
		cache = await cacheForUser(user);
	} else {
		if (Number(response.headers.get("Content-Length")) > Offline.MAX_FILE_BYTES) return;
		const name = await currentUserCache();
		if (!name) return;
		cache = await caches.open(name);
	}
	const headers = new Headers(response.headers);
	headers.delete("Vary");
	headers.set("X-Mailflare-Cached-At", String(Date.now()));
	const body = await response.arrayBuffer();
	if (body.byteLength > Offline.MAX_FILE_BYTES) return;
	await putTrimmed(cache, url.href, new Response(body, { status: 200, headers }), kind);
}

/** Fetch a page the user has not opened yet (the full-page composer) and keep it. */
async function warmPage(href) {
	const url = new URL(href, self.location.origin);
	if (url.origin !== self.location.origin || Offline.cacheKind(url) !== "page") return;
	const response = await fetch(url.href, { credentials: "same-origin", headers: { Accept: "text/html" } });
	if (response.status !== 200 || response.redirected) return;
	await storeDocument(url.href, await response.text(), response.headers);
}

/**
 * A download link is a navigation the worker never sees, so the page names the
 * attachment it just downloaded and the worker fetches its own copy, within the
 * size cap.
 */
async function keepFile(href) {
	const url = new URL(href, self.location.origin);
	if (url.origin !== self.location.origin || Offline.cacheKind(url) !== "file" || !(await currentUserCache())) return;
	const response = await fetch(url.href, { credentials: "same-origin" });
	if (response.status !== 200 || response.redirected) return;
	await storeMail(url, "file", response);
}

/** Messages from app.js: documents of boosted navigations, and pages and files to keep ahead of time. */
self.addEventListener("message", (event) => {
	const data = event.data;
	if (!data || typeof data !== "object" || typeof data.url !== "string") return;
	if (data.type === "store-page" && typeof data.html === "string") event.waitUntil(storeDocument(data.url, data.html, null).catch(() => false));
	else if (data.type === "warm") event.waitUntil(warmPage(data.url).catch(() => {}));
	else if (data.type === "keep-file") event.waitUntil(keepFile(data.url).catch(() => {}));
});

/* ---------- queued actions ----------
   Background Sync replays the outbox when the browser regains a connection,
   even with no v2 page open. It replays only for the user app.js last
   recorded; the server also refuses entries for anyone else (409). */

async function notifyClients(message) {
	const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
	for (const client of clients) client.postMessage(message);
}

self.addEventListener("sync", (event) => {
	if (event.tag !== Offline.SYNC_TAG) return;
	event.waitUntil((async () => {
		const user = await Offline.meta.get("user").catch(() => null);
		if (!user) return;
		const result = await Offline.withLock(() => Offline.drain(Offline.outbox, {
			fetch: (path, init) => fetch(path, init),
			user,
			onDropped: (message) => notifyClients({ type: "outbox-dropped", message }),
			onDraftId: (key, draftId) => notifyClients({ type: "outbox-draft", key, draftId }),
		}));
		if (result.signedOut) await Offline.purgeEverything();
		await notifyClients({ type: "outbox-drained", result });
		// Leaving entries behind asks the browser to try again later.
		if (result.remaining > 0 && !result.signedOut) throw new Error("Outbox not drained");
	})());
});
