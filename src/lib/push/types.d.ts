/** What a push carries to the service worker. Never a message body. */
export type PushNotificationPayload = {
	messageId: string;
	from: string;
	fromName: string | null;
	subject: string | null;
};

/**
 * A push job on OUTBOUND_QUEUE. The producer enqueues one per user; when a
 * single subscription fails transiently the consumer re-enqueues a job naming
 * just that subscription, so the user's other devices are not notified twice.
 */
export type PushQueueMessage = {
	kind: "push.notify";
	userId: string;
	notification: PushNotificationPayload;
	subscriptionId?: string;
	/** Deliveries already tried for `subscriptionId`. */
	attempt?: number;
};

/** VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT, all present. */
export type PushConfig = {
	publicKey: string;
	privateKey: string;
	subject: string;
};

/** The PushSubscription JSON shape, after validation. Keys stay base64url. */
export type PushSubscriptionInput = {
	endpoint: string;
	p256dh: string;
	auth: string;
};

/**
 * delivered: 2xx. gone: 404/410, the subscription is dead. retry: 429, 5xx or
 * a network error. failed: any other refusal (bad VAPID, payload too large),
 * which retrying will not fix.
 */
export type PushOutcome = "delivered" | "gone" | "retry" | "failed";

export type PushSendResult = {
	outcome: PushOutcome;
	status: number | null;
	error?: string;
};
