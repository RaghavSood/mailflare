import { base64UrlDecode, pointToJwkCoordinates } from "./encoding-utils";
import { isValidVapidSubject } from "./vapid-utils";
import type { PushConfig, PushNotificationPayload, PushOutcome, PushSubscriptionInput } from "./types";

/** New-mail notices go stale; a phone offline longer than this gets none. */
export const PUSH_TTL_SECONDS = 4 * 60 * 60;
/** Deliveries tried per subscription and message, the first included. */
export const MAX_PUSH_ATTEMPTS = 5;
const MAX_RETRY_DELAY_SECONDS = 600;
/** Each user's newest subscriptions are kept; older ones are dropped on subscribe. */
export const MAX_SUBSCRIPTIONS_PER_USER = 20;
const MAX_ENDPOINT_LENGTH = 2048;

/** Push is on only when all three VAPID values are set and usable. */
export function getPushConfig(env: Pick<CloudflareEnv, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">): PushConfig | null {
	const publicKey = env.VAPID_PUBLIC_KEY?.trim();
	const privateKey = env.VAPID_PRIVATE_KEY?.trim();
	const subject = env.VAPID_SUBJECT?.trim();
	if (!publicKey || !privateKey || !subject) return null;
	const point = base64UrlDecode(publicKey);
	if (!point || !pointToJwkCoordinates(point) || base64UrlDecode(privateKey)?.length !== 32 || !isValidVapidSubject(subject)) return null;
	return { publicKey, privateKey, subject };
}

/** Which VAPID settings are absent or malformed, for the admin overview. Never echoes values. */
export function describePushConfig(env: Pick<CloudflareEnv, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">): { configured: boolean; problems: string[] } {
	const problems: string[] = [];
	const publicKey = env.VAPID_PUBLIC_KEY?.trim();
	const privateKey = env.VAPID_PRIVATE_KEY?.trim();
	const subject = env.VAPID_SUBJECT?.trim();
	const point = publicKey ? base64UrlDecode(publicKey) : null;
	if (!publicKey) problems.push("VAPID_PUBLIC_KEY is not set");
	else if (!point || !pointToJwkCoordinates(point)) problems.push("VAPID_PUBLIC_KEY is not an uncompressed P-256 public key");
	if (!privateKey) problems.push("VAPID_PRIVATE_KEY is not set");
	else if (base64UrlDecode(privateKey)?.length !== 32) problems.push("VAPID_PRIVATE_KEY is not a 32-byte base64url key");
	if (!subject) problems.push("VAPID_SUBJECT is not set");
	else if (!isValidVapidSubject(subject)) problems.push("VAPID_SUBJECT must start with mailto: or https://");
	return { configured: problems.length === 0, problems };
}

function isPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host) || /^\d+$/.test(host) || /^0x/i.test(host)) return true;
	if (!host.includes(".")) return true;
	return /(^|\.)(localhost|local|internal|lan|home|arpa|test|invalid)$/.test(host);
}

/**
 * Accepts the PushSubscription JSON a browser produces (`{ endpoint, keys:
 * { p256dh, auth } }`). The server will POST to the endpoint, so it must be an
 * https URL on a public host name: no IP literals or local names.
 */
export function parsePushSubscription(value: unknown): PushSubscriptionInput | null {
	if (!value || typeof value !== "object") return null;
	const { endpoint, keys } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
	if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT_LENGTH) return null;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || isPrivateHost(url.hostname)) return null;
	const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh.replace(/=+$/, "") : "";
	const auth = typeof keys?.auth === "string" ? keys.auth.replace(/=+$/, "") : "";
	const point = base64UrlDecode(p256dh);
	if (!point || !pointToJwkCoordinates(point) || base64UrlDecode(auth)?.length !== 16) return null;
	return { endpoint: url.href, p256dh, auth };
}

function clip(value: string | null | undefined, length: number): string | null {
	if (!value) return null;
	const text = value.replace(/\s+/g, " ").trim();
	if (!text) return null;
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** The notice for one message: sender and subject only, clipped so it always fits one record. */
export function buildPushNotification(input: { messageId: string; from: string; fromName?: string | null; subject?: string | null }): PushNotificationPayload {
	return {
		messageId: input.messageId,
		from: clip(input.from, 254) ?? "",
		fromName: clip(input.fromName, 120),
		subject: clip(input.subject, 200),
	};
}

/** RFC 8030 §5-§8 status codes, as far as a sender can act on them. */
export function classifyPushStatus(status: number): PushOutcome {
	if (status >= 200 && status < 300) return "delivered";
	if (status === 404 || status === 410) return "gone";
	if (status === 429 || status >= 500) return "retry";
	return "failed";
}

/** Backoff before delivery `attempt` (2 for the first retry): 30 s, doubling, capped at 10 minutes. */
export function pushRetryDelaySeconds(attempt: number): number {
	return Math.min(MAX_RETRY_DELAY_SECONDS, 30 * 2 ** Math.max(0, attempt - 2));
}

/**
 * Splits a user's subscriptions into those to push to and those that are
 * dead: their session was signed out or expired (they would show a signed-out
 * device the sender and subject), or the browser subscribed under another
 * VAPID key (the push service would refuse every message with 403).
 */
export function partitionSubscriptions<T extends { vapidKeyId: string; sessionExpiresAt: Date | null }>(
	rows: T[],
	current: { vapidKeyId: string; now: Date },
): { live: T[]; stale: T[] } {
	const live: T[] = [];
	const stale: T[] = [];
	for (const row of rows) {
		const sessionLive = row.sessionExpiresAt !== null && row.sessionExpiresAt.getTime() > current.now.getTime();
		(sessionLive && row.vapidKeyId === current.vapidKeyId ? live : stale).push(row);
	}
	return { live, stale };
}

/**
 * Who gets a push for a new message: users with at least one subscription and
 * no open realtime socket. A user who is looking at the app already sees the
 * message arrive; a failed connection count counts as no socket, so a broken
 * check errs on the side of notifying.
 */
export function selectPushRecipients(userIds: string[], subscribedUserIds: Iterable<string>, openConnections: Map<string, number | null>): string[] {
	const subscribed = new Set(subscribedUserIds);
	return [...new Set(userIds)].filter((userId) => subscribed.has(userId) && !((openConnections.get(userId) ?? 0) > 0));
}
