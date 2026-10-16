import type { InboundQueueMessage } from "./src/lib/email/inbound";
import type { WebhookRetryMessage } from "./src/lib/email/webhooks";
import type { PushQueueMessage } from "./src/lib/push/types";

export function isInboundQueueMessage(payload: unknown): payload is InboundQueueMessage {
	return (
		typeof payload === "object" &&
		payload !== null &&
		"rawR2Key" in payload &&
		"from" in payload &&
		"to" in payload
	);
}

export function isWebhookRetryMessage(payload: unknown): payload is WebhookRetryMessage {
	return (
		typeof payload === "object" &&
		payload !== null &&
		(payload as { kind?: unknown }).kind === "webhook.retry" &&
		typeof (payload as { deliveryId?: unknown }).deliveryId === "string"
	);
}

export function isPushMessage(payload: unknown): payload is PushQueueMessage {
	if (typeof payload !== "object" || payload === null) return false;
	const message = payload as Partial<PushQueueMessage>;
	return (
		message.kind === "push.notify" &&
		typeof message.userId === "string" &&
		typeof message.notification === "object" &&
		message.notification !== null &&
		typeof message.notification.messageId === "string"
	);
}

/**
 * Paths `handleJmapRequest` owns, which `worker.ts` serves before Next. The
 * handler answers an OPTIONS request with an open CORS preflight whatever
 * its path, so it must only ever see these.
 */
export function isJmapPath(pathname: string): boolean {
	return pathname === "/.well-known/jmap" || pathname === "/jmap" || pathname.startsWith("/jmap/");
}

/**
 * Next adds the app's security headers (`headers()` in next.config.ts) to
 * every response it serves. A response `worker.ts` answers itself gets them
 * here instead, without replacing any header the response already set, such
 * as a blob download's sandboxing Content-Security-Policy. The copy also has
 * mutable headers, which `Response.redirect()` does not.
 */
export function withDefaultHeaders(response: Response, defaults: Array<{ key: string; value: string }>): Response {
	const headers = new Headers(response.headers);
	for (const { key, value } of defaults) {
		if (!headers.has(key)) headers.set(key, value);
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
