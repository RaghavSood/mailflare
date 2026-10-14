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
