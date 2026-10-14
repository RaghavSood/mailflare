import { and, count, desc, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { pushSubscriptions, sessions } from "@/db/schema";
import { pushNotificationIcon } from "@/lib/branding/install-utils";
import { getCachedBranding } from "@/lib/branding/service";
import { newId } from "@/lib/ids";
import {
	getPushConfig,
	MAX_PUSH_ATTEMPTS,
	MAX_SUBSCRIPTIONS_PER_USER,
	partitionSubscriptions,
	pushRetryDelaySeconds,
	selectPushRecipients,
} from "./push-utils";
import { sendPushToSubscription } from "./send";
import { vapidKeyId } from "./vapid-utils";
import type { PushNotificationPayload, PushQueueMessage, PushSubscriptionInput } from "./types";

type PushEnv = Pick<CloudflareEnv, "DB" | "REALTIME" | "OUTBOUND_QUEUE" | "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">;

/**
 * Stores a browser's subscription for the signed-in session, under the VAPID
 * key it subscribed with. The endpoint is unique, so a browser that
 * re-subscribes refreshes its keys, and one now signed in as someone else
 * moves to that account and session.
 */
export async function savePushSubscription(
	env: Pick<CloudflareEnv, "DB">,
	owner: { userId: string; sessionId: string; vapidKeyId: string },
	input: PushSubscriptionInput,
	userAgent: string | null,
): Promise<void> {
	const db = getDb(env);
	const { userId, sessionId } = owner;
	const agent = userAgent?.slice(0, 300) || null;
	const fields = { userId, sessionId, vapidKeyId: owner.vapidKeyId, p256dh: input.p256dh, auth: input.auth, userAgent: agent };
	await db
		.insert(pushSubscriptions)
		.values({ id: newId("push"), endpoint: input.endpoint, ...fields })
		.onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { ...fields, failedAt: null } });
	const rows = await db
		.select({ id: pushSubscriptions.id })
		.from(pushSubscriptions)
		.where(eq(pushSubscriptions.userId, userId))
		.orderBy(desc(pushSubscriptions.createdAt));
	const stale = rows.slice(MAX_SUBSCRIPTIONS_PER_USER).map((row) => row.id);
	if (stale.length > 0) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, stale));
}

/** Forgets one of the user's subscriptions; another user's endpoint is left alone. */
export async function removePushSubscription(env: Pick<CloudflareEnv, "DB">, userId: string, endpoint: string): Promise<void> {
	await getDb(env)
		.delete(pushSubscriptions)
		.where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

/**
 * Whether the server still pushes to `endpoint` for this user. A browser keeps
 * its subscription after the user signs out (which deletes the row), so the
 * page asks before showing notifications as on.
 */
export async function isPushSubscriptionRegistered(env: Pick<CloudflareEnv, "DB">, userId: string, endpoint: string): Promise<boolean> {
	const [row] = await getDb(env)
		.select({ id: pushSubscriptions.id })
		.from(pushSubscriptions)
		.where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
		.limit(1);
	return !!row;
}

export async function countPushSubscriptions(env: Pick<CloudflareEnv, "DB">): Promise<number> {
	const [row] = await getDb(env).select({ total: count() }).from(pushSubscriptions);
	return row?.total ?? 0;
}

/** Open realtime sockets for a user, from their RealtimeHub; null when the hub cannot say. */
async function getOpenConnectionCount(env: Pick<CloudflareEnv, "REALTIME">, userId: string): Promise<number | null> {
	try {
		const response = await env.REALTIME.getByName(userId).fetch("https://mailflare-realtime/connections");
		if (!response.ok) return null;
		const body = (await response.json()) as { connections?: unknown };
		return typeof body.connections === "number" ? body.connections : null;
	} catch {
		return null;
	}
}

/**
 * Producer: queues one push per user who has a subscription and no open
 * socket. Only enqueues, so inbound processing never waits on a push service.
 * Returns the users queued.
 */
export async function enqueuePushNotifications(env: PushEnv, userIds: string[], notification: PushNotificationPayload): Promise<string[]> {
	const config = getPushConfig(env);
	if (userIds.length === 0 || !config) return [];
	// Only subscriptions the consumer would actually send to: live session, current key.
	const rows = await getDb(env)
		.selectDistinct({ userId: pushSubscriptions.userId })
		.from(pushSubscriptions)
		.innerJoin(sessions, eq(sessions.id, pushSubscriptions.sessionId))
		.where(and(
			inArray(pushSubscriptions.userId, userIds),
			eq(pushSubscriptions.vapidKeyId, await vapidKeyId(config.publicKey)),
			gt(sessions.expiresAt, new Date()),
		));
	if (rows.length === 0) return [];
	const subscribed = rows.map((row) => row.userId);
	const openConnections = new Map(await Promise.all(subscribed.map(async (userId) => [userId, await getOpenConnectionCount(env, userId)] as const)));
	const recipients = selectPushRecipients(userIds, subscribed, openConnections);
	if (recipients.length > 0) {
		const icon = await getPushIcon(env);
		const notice = icon ? { ...notification, icon } : notification;
		await env.OUTBOUND_QUEUE.sendBatch(recipients.map((userId) => ({
			body: { kind: "push.notify", userId, notification: notice } satisfies PushQueueMessage,
		})));
	}
	return recipients;
}

/** A licensed custom icon for the notice; the service worker shows the packaged one otherwise. */
async function getPushIcon(env: PushEnv): Promise<string | null> {
	try {
		return pushNotificationIcon(await getCachedBranding(env));
	} catch {
		return null;
	}
}

/**
 * Consumer: sends the notice to each of the user's subscriptions (or the one a
 * retry names). Rows whose session ended or that were made under another VAPID
 * key are deleted unsent. 404/410 removes the subscription; 429, 5xx and
 * network errors re-enqueue that subscription alone with a capped backoff;
 * other refusals are recorded on `failed_at` and not retried.
 */
export async function processPushMessage(env: PushEnv, message: PushQueueMessage): Promise<{ delivered: number; removed: number; failed: number; retried: number }> {
	const summary = { delivered: 0, removed: 0, failed: 0, retried: 0 };
	const config = getPushConfig(env);
	if (!config) return summary;
	const db = getDb(env);
	const rows = await db
		.select({
			id: pushSubscriptions.id,
			endpoint: pushSubscriptions.endpoint,
			p256dh: pushSubscriptions.p256dh,
			auth: pushSubscriptions.auth,
			vapidKeyId: pushSubscriptions.vapidKeyId,
			sessionExpiresAt: sessions.expiresAt,
		})
		.from(pushSubscriptions)
		.leftJoin(sessions, eq(sessions.id, pushSubscriptions.sessionId))
		.where(message.subscriptionId
			? and(eq(pushSubscriptions.userId, message.userId), eq(pushSubscriptions.id, message.subscriptionId))
			: eq(pushSubscriptions.userId, message.userId));
	const { live: subscriptions, stale } = partitionSubscriptions(rows, { vapidKeyId: await vapidKeyId(config.publicKey), now: new Date() });
	if (stale.length > 0) {
		await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, stale.map((row) => row.id)));
		summary.removed += stale.length;
	}
	if (subscriptions.length === 0) return summary;

	const attempt = (message.attempt ?? 0) + 1;
	const results = await Promise.all(subscriptions.map(async (subscription) => ({
		subscription,
		result: await sendPushToSubscription(config, subscription, message.notification),
	})));

	const now = new Date();
	const deliveredIds: string[] = [];
	const goneIds: string[] = [];
	const failedIds: string[] = [];
	const retries: { body: PushQueueMessage; delaySeconds: number }[] = [];
	for (const { subscription, result } of results) {
		if (result.outcome === "delivered") {
			deliveredIds.push(subscription.id);
			continue;
		}
		if (result.outcome === "gone") {
			goneIds.push(subscription.id);
			continue;
		}
		failedIds.push(subscription.id);
		console.warn(`Push to ${new URL(subscription.endpoint).host} failed (${result.status ?? "network"}): ${result.error ?? "unknown error"}`);
		if (result.outcome === "retry" && attempt < MAX_PUSH_ATTEMPTS) {
			retries.push({
				body: { kind: "push.notify", userId: message.userId, notification: message.notification, subscriptionId: subscription.id, attempt },
				delaySeconds: pushRetryDelaySeconds(attempt + 1),
			});
		}
	}

	if (deliveredIds.length > 0) {
		await db.update(pushSubscriptions).set({ lastUsedAt: now, failedAt: null }).where(inArray(pushSubscriptions.id, deliveredIds));
	}
	if (goneIds.length > 0) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, goneIds));
	if (failedIds.length > 0) await db.update(pushSubscriptions).set({ failedAt: now }).where(inArray(pushSubscriptions.id, failedIds));
	if (retries.length > 0) await env.OUTBOUND_QUEUE.sendBatch(retries);

	return { delivered: deliveredIds.length, removed: summary.removed + goneIds.length, failed: failedIds.length, retried: retries.length };
}
