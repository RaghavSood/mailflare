/* Mailflare v2 offline support, shared by the page (loaded before app.js) and
   the service worker (importScripts). It holds the rules for what may be
   cached and queued, the IndexedDB outbox, and the replay that drains it.
   Everything a user stores offline is keyed by their user id: page caches are
   named mf-user-<id>, outbox entries carry the id, and a different id (or a
   sign-out) discards both. No build step; exposes self.MailflareOffline. */
(() => {
	"use strict";

	const DB_NAME = "mailflare-offline";
	const OUTBOX = "outbox";
	const META = "meta";
	const USER_CACHE_PREFIX = "mf-user-";
	const LOCK = "mf-outbox";
	const SYNC_TAG = "mf-outbox";
	/** Most recent pages, mail bodies and attachments kept per user. */
	const LIMITS = { page: 40, body: 200, file: 60 };
	const MAX_FILE_BYTES = 10 * 1024 * 1024;
	const MAX_ATTEMPTS = 5;

	/* ---------- what may be cached ---------- */

	const BODY_PATH = /^\/v2\/body\/[A-Za-z0-9_-]{1,64}$/;
	const FILE_PATH = /^\/api\/messages\/[A-Za-z0-9_-]{1,64}\/attachments\/[A-Za-z0-9_-]{1,64}$/;
	/** v2 routes that are not pages: actions, fragments and JSON. */
	const NOT_PAGES = new Set(["act", "undo", "send", "draft", "reply", "prefs", "switch", "poll", "contacts", "body", "headers", "unread-from"]);

	function userCacheName(user) {
		return `${USER_CACHE_PREFIX}${encodeURIComponent(user)}`;
	}
	function isUserCacheName(name) {
		return name.startsWith(USER_CACHE_PREFIX);
	}

	/** The kind of cached entry a same-origin URL is, or null if it is never cached. */
	function cacheKind(url) {
		if (BODY_PATH.test(url.pathname)) return "body";
		if (FILE_PATH.test(url.pathname)) return "file";
		if (url.pathname === "/v2" || !url.pathname.startsWith("/v2/")) return null;
		const segments = url.pathname.split("/");
		// /v2/compose is the full-page composer; /v2/compose/new is the docked one, a fragment.
		if (NOT_PAGES.has(segments[2] ?? "") || (segments[2] === "compose" && segments.length > 3)) return null;
		return "page";
	}

	/** The signed-in user a rendered v2 document belongs to (<body data-user>), or null. */
	function userFromHtml(text) {
		const match = /<body\b[^>]*\sdata-user="([^"]+)"/.exec(String(text).slice(0, 8192));
		return match ? match[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"') : null;
	}

	/** Mark a document served from the cache so the page can say how old it is. */
	function markCached(text, cachedAt) {
		return String(text).replace(/<body\b/, `<body data-cached-at="${Number(cachedAt) || 0}"`);
	}

	/** Cache keys over the kind's limit, oldest first (Cache Storage keeps insertion order). */
	function overLimit(urls, kind) {
		const same = urls.filter((url) => cacheKind(new URL(url)) === kind);
		return same.slice(0, Math.max(0, same.length - (LIMITS[kind] ?? 0)));
	}

	/* ---------- the banner and cached copies ---------- */

	/**
	 * The connectivity banner's text. copyTime is when the cached copy on screen
	 * was stored, already formatted ("" when the page is not a cached copy);
	 * reach is what the last try to reload it found: "unknown" (not tried since
	 * coming online), "down" or "up" (the server answered, but the page is held
	 * because something on it is being worked on).
	 */
	function bannerText({ offline, copyTime = "", pending = 0, reach = "unknown" }) {
		const waiting = pending ? ` · ${pending} ${pending === 1 ? "change" : "changes"} waiting` : "";
		const copy = copyTime ? ` · copy from ${copyTime}` : "";
		if (offline) return `Offline${copy}${waiting}`;
		if (!copyTime) return `Syncing${waiting}`;
		if (reach === "up") return `Saved copy from ${copyTime}${waiting}`;
		if (reach === "down") return `Couldn't reach Mailflare${copy}${waiting}`;
		return `Reconnecting${copy}${waiting}`;
	}

	const RETRY_FIRST_MS = 1500;
	const RETRY_MAX_MS = 60000;

	/** How long to wait before try number `attempt` (from 0) to reload a cached copy. */
	function retryDelay(attempt) {
		const step = Math.max(0, Math.floor(Number(attempt) || 0));
		return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(step, 16));
	}

	/**
	 * How long a page waits before draining the outbox again after `result`, or
	 * null for not at all. Only a drain that could not reach the server while the
	 * browser says it is online is retried (the network can be up a moment before
	 * the server is): a server error already counts against the entry's attempts,
	 * so retrying it here would drop the entry within seconds. A cached copy's own
	 * reload tries drain first, so it gets no second schedule.
	 */
	function drainRetryDelay(result, { online, cached = false, attempt = 0 }) {
		if (!online || cached || !result || result.signedOut || !result.remaining || !result.unreachable) return null;
		return retryDelay(attempt);
	}

	/**
	 * What the page does when htmx cannot reach the server (#44): "navigate" (a
	 * boosted page becomes a full navigation the worker can answer from its
	 * cache), "send" or "act" (it goes to the outbox; the page already shows it
	 * done), "silent" (a request the page made on its own, such as a quiet reload
	 * or refilling a list: the banner already says why, and the page reloads once
	 * the server answers, so it must not replace a confirmation on screen) or
	 * "toast" (anything else the person asked for says it could not be done).
	 */
	function sendFailure({ verb, boosted = false, sameOrigin = true, background = false, kind = null }) {
		if (background) return "silent";
		if (verb === "get" && boosted && sameOrigin) return "navigate";
		if (verb === "post" && (kind === "send" || kind === "act")) return kind;
		return "toast";
	}

	/* ---------- what may be queued ---------- */

	/** Forward actions only: undo depends on server state and never queues. */
	const QUEUEABLE_ACTIONS = new Set(["archive", "trash", "spam", "inbox", "read", "unread", "star", "unstar"]);
	const QUEUEABLE_MOVES = /^(inbox|archive|spam|trash|folder:[A-Za-z0-9_-]{1,64})$/;

	/** Whether a failed POST may go to the outbox, and as what. */
	function queueKind(path, fields) {
		const value = (name) => {
			const found = fields.find(([key]) => key === name);
			return found && typeof found[1] === "string" ? found[1] : "";
		};
		if (path === "/v2/draft") return "draft";
		if (path === "/v2/send") return "send";
		if (path !== "/v2/act") return null;
		if (!fields.some(([key, item]) => key === "ids" && item)) return null;
		if (value("snooze")) return "act";
		if (value("move")) return QUEUEABLE_MOVES.test(value("move")) ? "act" : null;
		return QUEUEABLE_ACTIONS.has(value("action")) ? "act" : null;
	}

	const pad = (value) => String(value).padStart(2, "0");
	const localStamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const at = (date, days, hour) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, hour, 0, 0, 0);

	/**
	 * A snooze preset as the absolute datetime-local the server's
	 * resolveSnoozeTime would pick now, in this browser's zone (the same zone the
	 * mf_tz cookie names), so a late replay still lands on the intended time.
	 */
	function resolveSnoozePreset(choice, now = new Date()) {
		const weekday = now.getDay();
		if (choice === "later") return localStamp(now.getHours() < 17 ? at(now, 0, 18) : new Date(now.getTime() + 3 * 3600_000));
		if (choice === "tomorrow") return localStamp(at(now, 1, 8));
		if (choice === "weekend") return localStamp(at(now, weekday === 6 ? 7 : (6 - weekday + 7) % 7 || 7, 8));
		if (choice === "nextweek") return localStamp(at(now, (1 - weekday + 7) % 7 || 7, 8));
		return null;
	}

	/** Form fields ready to store: snooze presets fixed to a time, page-only flags dropped. */
	function prepareFields(kind, fields, now = new Date()) {
		let out = fields.filter(([key]) => key !== "partial" && key !== "quiet");
		if (kind === "act") {
			const snooze = out.find(([key]) => key === "snooze")?.[1];
			const resolved = typeof snooze === "string" && snooze !== "custom" ? resolveSnoozePreset(snooze, now) : null;
			if (resolved) out = out.filter(([key]) => key !== "snooze" && key !== "snoozeAt").concat([["snooze", "custom"], ["snoozeAt", resolved]]);
		}
		if (kind === "draft") out = out.filter(([key]) => key !== "attachments");
		if (kind === "send") out = out.filter(([key, value]) => key !== "attachments" || (value && typeof value === "object" && value.size > 0));
		return out;
	}

	function newRequestId() {
		if (self.crypto?.randomUUID) return self.crypto.randomUUID();
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	}

	/**
	 * The outbox after adding an entry. A composer keeps at most one pending
	 * draft save, and sending it supersedes that save (the send saves first).
	 * Discarding it supersedes everything the composer still had queued: the
	 * discard is all that is left to tell the server.
	 */
	function enqueue(entries, entry) {
		const sameComposer = (item) => entry.key && item.key === entry.key && (entry.kind === "discard" || item.kind === "draft");
		const kept = entry.kind === "draft" || entry.kind === "send" || entry.kind === "discard" ? entries.filter((item) => !sameComposer(item)) : entries.slice();
		return kept.concat([entry]).sort(byQueueOrder);
	}

	/** One user's queued entries for one composer: what discarding that composer removes. */
	function ofComposer(entries, user, key) {
		return key ? entries.filter((item) => item.user === user && item.key === key) : [];
	}

	function byQueueOrder(a, b) {
		return a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id));
	}

	function setDraftId(entry, draftId) {
		return { ...entry, fields: entry.fields.filter(([name]) => name !== "draftId").concat([["draftId", draftId]]) };
	}

	/** Entries of one composer that still lack the server draft id it just got. */
	function withDraftId(entries, key, draftId) {
		return entries.filter((item) => key && item.key === key && !fieldValue(item.fields, "draftId")).map((item) => setDraftId(item, draftId));
	}

	function fieldValue(fields, name) {
		const found = fields.find(([key]) => key === name);
		return found && typeof found[1] === "string" ? found[1] : "";
	}

	function toFormData(fields, extra = []) {
		const data = new FormData();
		for (const [key, value] of fields.concat(extra)) {
			if (value && typeof value === "object" && "blob" in value) data.append(key, value.blob, value.name);
			else if (value && typeof value === "object" && typeof value.size === "number") data.append(key, value, value.name);
			else data.append(key, String(value ?? ""));
		}
		return data;
	}

	/* ---------- replay ---------- */

	const OFFLINE = { outcome: "offline" };

	async function post(fetchFn, path, fields, user, accept) {
		try {
			return await fetchFn(path, {
				method: "POST",
				body: toFormData(fields),
				credentials: "same-origin",
				// Sends and conversation actions answer with a redirect to a page nobody will see.
				redirect: "manual",
				headers: { Accept: accept, "X-Mailflare-User": user },
			});
		} catch {
			return null;
		}
	}

	async function readText(response) {
		try {
			const text = (await response.text()).trim();
			return text.length > 300 ? "" : text;
		} catch {
			return "";
		}
	}

	/** What a reply means for the entry: done, dropped (with the server's reason), or try later. */
	async function settle(response) {
		if (!response) return OFFLINE;
		if (response.status === 401) return { outcome: "signedOut" };
		if (response.ok || response.status === 410 || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) return { outcome: "done" };
		if (response.status === 422 || response.status === 409 || response.status === 403 || response.status === 404) {
			return { outcome: "dropped", message: (await readText(response)) || "A change made offline couldn't be applied." };
		}
		return { outcome: "retry" };
	}

	/**
	 * Replay one entry. Sends save the server draft first and send with its id;
	 * the server refuses (410) to send a draft that no longer exists, so a send
	 * whose response was lost cannot go out twice.
	 */
	async function replayEntry(entry, { fetch: fetchFn, user, store }) {
		if (entry.kind === "act") {
			const flag = fieldValue(entry.fields, "conversation") === "1" ? "quiet" : "partial";
			return settle(await post(fetchFn, "/v2/act", entry.fields.concat([[flag, "1"]]), user, "text/html"));
		}
		// The server finds the draft by its id or, when the composer never learned it, by the composer key.
		if (entry.kind === "discard") return settle(await post(fetchFn, "/v2/draft/discard", entry.fields, user, "application/json"));
		const text = entry.fields.filter(([key]) => key !== "attachments");
		const saved = await post(fetchFn, "/v2/draft", text, user, "application/json");
		if (!saved) return OFFLINE;
		if (saved.status === 410) return { outcome: "done" };
		if (!saved.ok) return settle(saved);
		let draftId = "";
		try {
			draftId = String((await saved.json()).draftId ?? "");
		} catch {
			return { outcome: "retry" };
		}
		if (!draftId) return { outcome: "retry" };
		if (entry.kind === "draft") return { outcome: "done", draftId };
		// From here a replay only ever sends this draft.
		const updated = setDraftId(entry, draftId);
		await store.put(updated);
		const sent = await settle(await post(fetchFn, "/v2/send", updated.fields, user, "text/html"));
		return { ...sent, draftId };
	}

	/**
	 * Drain the outbox in order. Stops at the first entry that cannot reach the
	 * server (result.unreachable), so later actions never overtake earlier ones. Entries of any other
	 * user are never sent; discarding them is adoptUser's and sign-out's job,
	 * not that of a stale tab that has not noticed the switch.
	 */
	async function drain(store, { fetch: fetchFn, user, onDropped = () => {}, onDraftId = () => {} }) {
		const result = { sent: 0, dropped: 0, remaining: 0, signedOut: false, unreachable: false };
		if (!user) return result;
		const pending = async () => (await store.all()).filter((entry) => entry.user === user).sort(byQueueOrder);
		let entries = await pending();
		while (entries.length) {
			const entry = entries[0];
			const outcome = await replayEntry(entry, { fetch: fetchFn, user, store });
			if (outcome.draftId && entry.key) {
				for (const item of withDraftId(entries.slice(1), entry.key, outcome.draftId)) await store.put(item);
				onDraftId(entry.key, outcome.draftId);
			}
			if (outcome.outcome === "offline") {
				result.unreachable = true;
				break;
			}
			if (outcome.outcome === "signedOut") {
				result.signedOut = true;
				break;
			}
			if (outcome.outcome === "retry") {
				const attempts = (entry.attempts ?? 0) + 1;
				if (attempts < MAX_ATTEMPTS) {
					await store.put({ ...entry, attempts });
					break;
				}
				outcome.outcome = "dropped";
				outcome.message = "A change made offline couldn't be applied.";
			}
			await store.delete(entry.id);
			if (outcome.outcome === "dropped") {
				result.dropped += 1;
				onDropped(outcome.message, entry);
			} else {
				result.sent += 1;
			}
			entries = await pending();
		}
		result.remaining = (await pending()).length;
		return result;
	}

	/* ---------- IndexedDB ---------- */

	let dbPromise = null;

	function request(req) {
		return new Promise((resolve, reject) => {
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	function openDb() {
		if (!self.indexedDB) return Promise.reject(new Error("IndexedDB unavailable"));
		if (dbPromise) return dbPromise;
		const open = self.indexedDB.open(DB_NAME, 1);
		open.onupgradeneeded = () => {
			const db = open.result;
			if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: "id" });
			if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
		};
		dbPromise = request(open).then((db) => {
			// A sign-out elsewhere deletes the database; let it.
			db.onversionchange = () => {
				db.close();
				dbPromise = null;
			};
			db.onclose = () => (dbPromise = null);
			return db;
		});
		dbPromise.catch(() => (dbPromise = null));
		return dbPromise;
	}

	async function tx(name, mode, fn) {
		const db = await openDb();
		const transaction = db.transaction(name, mode);
		const result = fn(transaction.objectStore(name));
		await new Promise((resolve, reject) => {
			transaction.oncomplete = resolve;
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		return result instanceof IDBRequest ? result.result : result;
	}

	const outboxStore = {
		all: () => tx(OUTBOX, "readonly", (store) => store.getAll()),
		put: (entry) => tx(OUTBOX, "readwrite", (store) => store.put(entry)),
		delete: (id) => tx(OUTBOX, "readwrite", (store) => store.delete(id)),
		clear: () => tx(OUTBOX, "readwrite", (store) => store.clear()),
		/** Add an entry and apply enqueue's de-duplication in one transaction. */
		add: async (entry) => {
			const entries = await outboxStore.all();
			const next = enqueue(entries, entry);
			const keep = new Set(next.map((item) => item.id));
			await tx(OUTBOX, "readwrite", (store) => {
				for (const item of entries) if (!keep.has(item.id)) store.delete(item.id);
				store.put(entry);
			});
		},
	};

	const meta = {
		get: (key) => tx(META, "readonly", (store) => store.get(key)),
		set: (key, value) => tx(META, "readwrite", (store) => store.put(value, key)),
	};

	/** Run fn with the outbox to itself (page and worker may both try to drain). */
	function withLock(fn) {
		const locks = self.navigator?.locks;
		return locks?.request ? locks.request(LOCK, fn) : fn();
	}

	/** Drop every user's cached mail and the whole outbox (sign-out, or another user signed in). */
	async function purgeEverything() {
		if (self.caches) {
			const names = await self.caches.keys();
			await Promise.all(names.filter(isUserCacheName).map((name) => self.caches.delete(name)));
		}
		try {
			await outboxStore.clear();
			await meta.set("user", null);
		} catch {
			/* no IndexedDB: nothing was queued */
		}
	}

	/** Keep only `user`'s data: other users' caches and queued actions are discarded. */
	async function adoptUser(user) {
		if (!user) return;
		let previous = null;
		try {
			previous = await meta.get("user");
		} catch {
			previous = null;
		}
		if (previous && previous !== user) await purgeEverything();
		if (self.caches) {
			const names = await self.caches.keys();
			await Promise.all(names.filter((name) => isUserCacheName(name) && name !== userCacheName(user)).map((name) => self.caches.delete(name)));
		}
		try {
			if (previous !== user) await meta.set("user", user);
			const stray = (await outboxStore.all()).filter((entry) => entry.user !== user);
			for (const entry of stray) await outboxStore.delete(entry.id);
		} catch {
			/* no IndexedDB */
		}
	}

	self.MailflareOffline = {
		DB_NAME,
		SYNC_TAG,
		LIMITS,
		MAX_FILE_BYTES,
		userCacheName,
		isUserCacheName,
		cacheKind,
		userFromHtml,
		markCached,
		overLimit,
		bannerText,
		retryDelay,
		drainRetryDelay,
		sendFailure,
		queueKind,
		resolveSnoozePreset,
		prepareFields,
		newRequestId,
		enqueue,
		ofComposer,
		withDraftId,
		fieldValue,
		toFormData,
		drain,
		outbox: outboxStore,
		meta,
		withLock,
		purgeEverything,
		adoptUser,
	};
})();
