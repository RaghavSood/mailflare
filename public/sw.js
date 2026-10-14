/* Mailflare v2 service worker, registered by app.js with scope /v2/.
   The registration URL carries the asset versions (?v=<ASSET_VERSION>&htmx=<version>),
   so bumping ASSET_VERSION installs a new worker that precaches the new assets
   and drops the old ones. Pages are network-first; a navigation that cannot
   reach the server gets the offline page. Only static assets are cached here:
   v2 pages hold mail, so caching them needs the per-user keying that comes with
   offline reading.
   It also shows new-mail push notifications (the server decides whether to
   send one, so every push shows a notification, as Chrome requires) and
   keeps the push subscription registered with the server. */
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
		icon: "/icon-192.png",
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
