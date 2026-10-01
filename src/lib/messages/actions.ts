import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, messages } from "@/db/schema";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import {
	getReadValueForBulkAction,
	getStatusForBulkAction,
} from "@/app/api/messages/bulk/utils";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { applySpamFeedback } from "@/lib/spam/feedback";

export class MessageActionError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

/**
 * Archive, trash, spam, move, or mark messages read/unread, for every listed
 * message the user may change. Spam and not-spam also train the filter. Shared
 * by the bulk API and the v2 interface; returns the ids actually changed.
 */
export async function applyMessageAction(
	env: CloudflareEnv,
	user: SessionUser,
	input: { messageIds: string[]; action: BulkMessageAction; folderId?: string | null },
): Promise<string[]> {
	const messageIds = input.messageIds.filter(Boolean);
	if (messageIds.length === 0) throw new MessageActionError("Invalid bulk message action", 400);
	const { action } = input;
	const status = getStatusForBulkAction(action);
	const read = getReadValueForBulkAction(action);
	const db = getDb(env);
	let folderId: string | null | undefined;

	if (action === "folder") {
		if (!input.folderId) throw new MessageActionError("Folder is required", 400);
		const [folder] = await db
			.select({ id: folders.id, mailboxId: folders.mailboxId })
			.from(folders)
			.where(eq(folders.id, input.folderId))
			.limit(1);
		if (!folder) throw new MessageActionError("Folder not found", 404);
		const folderAccess = await getMailboxAccessLevel(db, user, folder.mailboxId);
		if (!folderAccess?.canManage) throw new MessageActionError("Folder not found", 404);
		folderId = folder.id;
	} else if (action === "spam" || action === "trash" || action === "inbox" || action === "archive") {
		folderId = null;
	}

	const values = {
		...(status ? { status } : {}),
		...(read !== null ? { read } : {}),
		...(folderId !== undefined ? { folderId } : {}),
	};
	if (Object.keys(values).length === 0) throw new MessageActionError("No changes requested", 400);

	const selectedMessages = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId, status: messages.status })
		.from(messages)
		.where(inArray(messages.id, messageIds));
	const accessByMailbox = new Map<string, Awaited<ReturnType<typeof getMailboxAccessLevel>>>();
	const allowedMessageIds: string[] = [];
	for (const message of selectedMessages) {
		if (!message.mailboxId) continue;
		if (!accessByMailbox.has(message.mailboxId)) {
			accessByMailbox.set(message.mailboxId, await getMailboxAccessLevel(db, user, message.mailboxId));
		}
		const access = accessByMailbox.get(message.mailboxId);
		const canUpdate = action === "read" || action === "unread" ? access?.canRead : access?.canManage;
		if (canUpdate) allowedMessageIds.push(message.id);
	}
	if (allowedMessageIds.length === 0) throw new MessageActionError("No accessible messages", 404);

	if (action === "spam") {
		for (const messageId of allowedMessageIds) await applySpamFeedback(env, user, messageId, "spam");
		return allowedMessageIds;
	}
	if (action === "inbox") {
		const spamMessageIds = selectedMessages
			.filter((message) => message.status === "spam" && allowedMessageIds.includes(message.id))
			.map((message) => message.id);
		const normalMessageIds = allowedMessageIds.filter((messageId) => !spamMessageIds.includes(messageId));
		for (const messageId of spamMessageIds) await applySpamFeedback(env, user, messageId, "ham");
		if (normalMessageIds.length) await db.update(messages).set(values).where(inArray(messages.id, normalMessageIds));
		return allowedMessageIds;
	}

	await db.update(messages).set(values).where(inArray(messages.id, allowedMessageIds));
	await Promise.all(
		allowedMessageIds.map((messageId) =>
			createAuditLog(env, {
				actorUserId: user.id,
				messageId,
				action: action === "read" || action === "unread" ? "email.read" : "email.delete",
				metadata: { bulkAction: action },
			}),
		),
	);
	return allowedMessageIds;
}
