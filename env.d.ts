interface CloudflareEnv {
	DB: D1Database;
	EMAIL: SendEmail;
	BUCKET: R2Bucket;
	INBOUND_QUEUE: Queue<import("./src/lib/email/inbound").InboundQueueMessage>;
	// The outbound queue also carries webhook retries so that scheduled redelivery needs no extra binding.
	OUTBOUND_QUEUE: Queue<
		| import("./src/lib/email/send").OutboundQueueMessage
		| import("./src/lib/email/webhooks").WebhookRetryMessage
		| import("./src/lib/push/types").PushQueueMessage
	>;
	ASSETS: Fetcher;
	IMAGES: ImagesBinding;
	WORKER_SELF_REFERENCE: Fetcher;
	REALTIME: DurableObjectNamespace<
		import("./src/lib/realtime/hub").RealtimeHub
	>;
	LOGIN_RATE_LIMIT?: RateLimit;
	CF_TOKEN?: string;
	CF_API_KEY?: string;
	CF_EMAIL?: string;
	TURNSTILE_SECRET_KEY?: string;
	GITHUB_UPDATE_TOKEN?: string;
	GITHUB_UPDATE_REF?: string;
	GITHUB_UPDATE_REPO?: string;
	/** "node" when served by the self-hosted runtime in server/; unset on Workers. */
	MAILFLARE_RUNTIME?: "node";
	/** Shared secret the Cloudflare email relay signs inbound webhooks with (self-hosted only). */
	INBOUND_WEBHOOK_SECRET?: string;
	/** Cloudflare account id, needed for the Email Sending REST API off Workers. */
	CF_ACCOUNT_ID?: string;
	/** Public origin of this install (https://mail.example.com) when it sits behind a proxy. */
	APP_URL?: string;
	/** Web Push application server key: the uncompressed P-256 public point, base64url. */
	VAPID_PUBLIC_KEY?: string;
	/** The matching private scalar, base64url. Secret. */
	VAPID_PRIVATE_KEY?: string;
	/** Contact for push services, `mailto:` or `https:` (RFC 8292). */
	VAPID_SUBJECT?: string;
}
