import { encryptPushPayload } from "./encrypt-utils";
import { classifyPushStatus, PUSH_TTL_SECONDS } from "./push-utils";
import { vapidAuthorization } from "./vapid-utils";
import type { PushConfig, PushNotificationPayload, PushSendResult, PushSubscriptionInput } from "./types";

/**
 * Encrypts `payload` for one subscription and POSTs it to the push service
 * (RFC 8030 §5). Depends only on its arguments, so a script can call it
 * outside the queue consumer.
 */
export async function sendPushToSubscription(
	config: PushConfig,
	subscription: PushSubscriptionInput,
	payload: PushNotificationPayload,
	options: { fetch?: typeof fetch; ttlSeconds?: number } = {},
): Promise<PushSendResult> {
	let body: Uint8Array<ArrayBuffer>;
	let authorization: string;
	try {
		body = await encryptPushPayload(new TextEncoder().encode(JSON.stringify(payload)), subscription);
		authorization = await vapidAuthorization(config, subscription.endpoint);
	} catch (error) {
		return { outcome: "failed", status: null, error: error instanceof Error ? error.message : "Could not encrypt the push message" };
	}

	try {
		const response = await (options.fetch ?? fetch)(subscription.endpoint, {
			method: "POST",
			headers: {
				Authorization: authorization,
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				TTL: String(options.ttlSeconds ?? PUSH_TTL_SECONDS),
				Urgency: "normal",
			},
			body,
		});
		const outcome = classifyPushStatus(response.status);
		if (outcome === "delivered") return { outcome, status: response.status };
		const detail = (await response.text().catch(() => "")).slice(0, 200);
		return { outcome, status: response.status, error: detail || response.statusText || `HTTP ${response.status}` };
	} catch (error) {
		return { outcome: "retry", status: null, error: error instanceof Error ? error.message : "Network error" };
	}
}
