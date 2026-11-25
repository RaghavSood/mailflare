import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxAccess, mailboxes } from "@/db/schema";
import { isTeamMailboxSharingEnabled } from "@/lib/mailboxes/access-utils";
import { enqueuePushNotifications } from "@/lib/push/delivery";
import { buildPushNotification } from "@/lib/push/push-utils";
import type { NewMessageNotification } from "./types";

export function getSessionTokenFromRequest(request: Request): string | undefined {
	const cookie = request.headers.get("Cookie");
	if (!cookie) return undefined;

	for (const part of cookie.split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (name === "ep_session") {
			const value = valueParts.join("=");
			return value ? decodeURIComponent(value) : undefined;
		}
	}

	return undefined;
}

/**
 * Who hears about new mail in a mailbox: exactly the users who can read it
 * (see `getMailboxAccessLevel`), so its owner and, for a shared mailbox, the
 * users it is shared with. Owning the domain grants no access, so a domain
 * owner is not told about other people's mail.
 */
export async function getMailboxNotificationUserIds(
	env: CloudflareEnv,
	mailboxId: string,
	ownerUserId: string,
): Promise<string[]> {
	const db = getDb(env);
	const [mailbox] = await db
		.select({ type: mailboxes.type })
		.from(mailboxes)
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	const sharedUserIds = mailbox?.type === "shared" && await isTeamMailboxSharingEnabled(db)
		? (await db
			.select({ userId: mailboxAccess.userId })
			.from(mailboxAccess)
			.where(eq(mailboxAccess.mailboxId, mailboxId)))
			.map((access) => access.userId)
		: [];

	return [...new Set([ownerUserId, ...sharedUserIds].filter((userId): userId is string => !!userId))];
}

/**
 * Tells each user's open tabs about a new message and queues a Web Push for
 * the users who have none open. Failures here never fail inbound processing.
 */
export async function notifyUsersOfNewMessage(
	env: CloudflareEnv,
	userIds: string[],
	payload: NewMessageNotification,
): Promise<void> {
	const results = await Promise.allSettled([
		...userIds.map((userId) => {
			const hub = env.REALTIME.getByName(userId);
			return hub.fetch("https://mailflare-realtime/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
		}),
		enqueuePushNotifications(env, userIds, buildPushNotification(payload)),
	]);
	const push = results[results.length - 1];
	if (push?.status === "rejected") console.error("Could not queue push notifications", push.reason);
}
