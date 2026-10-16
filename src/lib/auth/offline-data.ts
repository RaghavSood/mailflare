/**
 * The v2 app keeps pages, mail bodies and attachments in Cache Storage
 * (mf-user-<id>) and queued actions in IndexedDB (public/v2-assets/offline.js).
 * Its service worker cannot see a sign-out, so the pages that end or follow a
 * session clear them here. The names must match offline.js.
 */
const USER_CACHE_PREFIX = "mf-user-";
const OFFLINE_DB = "mailflare-offline";

export async function clearOfflineData(): Promise<void> {
	if (typeof window === "undefined") return;
	try {
		if ("caches" in window) {
			const names = await caches.keys();
			await Promise.all(names.filter((name) => name.startsWith(USER_CACHE_PREFIX)).map((name) => caches.delete(name)));
		}
	} catch {
		// Cache Storage is unavailable outside secure contexts.
	}
	try {
		// Open v2 tabs close their connection when asked, so this does not stay blocked.
		indexedDB?.deleteDatabase(OFFLINE_DB);
	} catch {
		// IndexedDB unavailable (private mode in some browsers).
	}
}
