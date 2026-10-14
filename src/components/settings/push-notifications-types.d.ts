/**
 * The opt-in's state on this device; `unavailable` means the server has no
 * VAPID key, `offline` that the page could not ask it.
 */
export type PushControlState = "loading" | "unavailable" | "offline" | "unsupported" | "install" | "blocked" | "off" | "on" | "busy";

export type PushKeyResponse = {
	publicKey: string | null;
	serviceWorker: string;
};

export type PushEnvironment = {
	publicKey: string | null;
	supported: boolean;
	ios: boolean;
	standalone: boolean;
	permission: NotificationPermission | null;
	/** applicationServerKey of the current subscription, base64url, or null when unsubscribed. */
	subscribedKey: string | null;
	subscribed: boolean;
	/** Whether the server still pushes to this browser's endpoint for the signed-in user; null when it could not say. */
	registered: boolean | null;
};
