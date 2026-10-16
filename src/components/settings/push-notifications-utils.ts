import type { PushControlState, PushEnvironment, PushKeyResponse } from "./push-notifications-types";

/** Where the browser stands, as the toggle should show it. Mirrors readPushState in public/v2-assets/app.js. */
export function resolvePushControlState(environment: PushEnvironment): PushControlState {
	if (!environment.publicKey) return "unavailable";
	if (environment.ios && !environment.standalone) return "install";
	if (!environment.supported) return "unsupported";
	if (environment.permission === "denied") return "blocked";
	if (!environment.subscribed || environment.permission !== "granted") return "off";
	if (environment.subscribedKey && environment.subscribedKey !== environment.publicKey) return "off";
	// Signing out removes the server's row; the browser's subscription alone is not "on".
	if (environment.registered === false) return "off";
	return "on";
}

export const PUSH_OFFLINE_MESSAGE = "You're offline. Turn notifications on or off once you're back online.";

/** Loading the server's key failed: offline is not the same as push not being configured. */
export function pushKeyFailureState(error: unknown, online: boolean): "offline" | "unavailable" {
	return !online || error instanceof TypeError ? "offline" : "unavailable";
}

/**
 * The state to show: still checking while offline is offline. An "offline"
 * result stays until the reload that reconnecting starts replaces it, since a
 * connection that fails while the browser reports online is offline too.
 */
export function shownPushControlState(state: PushControlState, online: boolean): PushControlState {
	return !online && state === "loading" ? "offline" : state;
}

/** What to tell the user when turning notifications on or off failed. Mirrors pushErrorMessage in public/v2-assets/app.js. */
export function describePushError(error: unknown, online: boolean, fallback: string): string {
	// fetch rejects with a TypeError ("Failed to fetch") when the connection drops mid-change.
	if (!online || error instanceof TypeError) return PUSH_OFFLINE_MESSAGE;
	if (error instanceof DOMException && error.name === "AbortError") return "Couldn't reach the push service. Check your connection and try again.";
	return error instanceof Error && error.message ? error.message : fallback;
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function bytesToBase64Url(buffer: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function loadPushKey(): Promise<PushKeyResponse> {
	const response = await fetch("/v2/push/key", { cache: "no-store", headers: { Accept: "application/json" } });
	if (!response.ok) throw new Error("Could not check notifications");
	return (await response.json()) as PushKeyResponse;
}

/** Whether the server still pushes to `endpoint` for the signed-in user; null when it cannot say. */
export async function checkPushSubscription(endpoint: string): Promise<boolean | null> {
	try {
		const response = await fetch("/v2/push/check", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ endpoint }),
		});
		if (!response.ok) return null;
		return ((await response.json()) as { subscribed?: unknown }).subscribed === true;
	} catch {
		return null;
	}
}

export async function postPushSubscription(path: "/v2/push/subscribe" | "/v2/push/unsubscribe", value: unknown): Promise<void> {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(value),
	});
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? "Could not update notifications");
	}
}

/**
 * The v2 service worker's registration (scope /v2/) once it is active. This
 * page is outside that scope, so `navigator.serviceWorker.ready` would never
 * settle here; register with the exact versioned URL v2 uses if needed.
 */
export async function getActivePushRegistration(serviceWorkerUrl: string): Promise<ServiceWorkerRegistration> {
	const registration = (await navigator.serviceWorker.getRegistration("/v2/"))
		?? (await navigator.serviceWorker.register(serviceWorkerUrl, { scope: "/v2/" }));
	if (registration.active) return registration;
	const worker = registration.installing ?? registration.waiting;
	await new Promise<void>((resolve) => {
		worker?.addEventListener("statechange", () => {
			if (worker.state === "activated") resolve();
		});
	});
	return registration;
}

export async function readPushEnvironment(publicKey: string | null): Promise<PushEnvironment> {
	const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
	const registration = supported ? await navigator.serviceWorker.getRegistration("/v2/").catch(() => undefined) : undefined;
	const subscription = registration ? await registration.pushManager.getSubscription().catch(() => null) : null;
	const key = subscription?.options.applicationServerKey;
	const registered = subscription ? await checkPushSubscription(subscription.endpoint) : null;
	// The server forgot this endpoint (the user signed out): drop the browser's side too.
	if (subscription && registered === false) await subscription.unsubscribe().catch(() => false);
	return {
		publicKey,
		supported,
		ios: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
		standalone: window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
		permission: "Notification" in window ? Notification.permission : null,
		subscribedKey: key ? bytesToBase64Url(key) : null,
		subscribed: !!subscription && registered !== false,
		registered,
	};
}
