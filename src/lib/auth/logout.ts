import { authFetch, clearClientSessionToken } from "@/lib/auth/client";
import { clearOfflineData } from "@/lib/auth/offline-data";

export async function logoutClientSession(): Promise<void> {
	try {
		await authFetch("/api/auth/logout", {
			method: "POST",
			redirectOnUnauthorized: false,
		});
	} catch {
		// Local logout must complete even when the server request is unavailable.
	} finally {
		clearClientSessionToken();
		// The next person on this browser must not see this account's mail offline.
		await clearOfflineData();
	}
}
