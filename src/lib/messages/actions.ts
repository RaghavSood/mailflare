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
import { createAuditLogs } from "@/lib/mailboxes/audit";
import { runAfterResponse } from "@/lib/http/after-response";
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

	// The status change is what the user waits for; spam training and audit rows
	// happen after the response.
	if (action === "spam") {
		await updateInChunks(db, allowedMessageIds, values);
		runAfterResponse("Spam training", async () => {
			for (const messageId of allowedMessageIds) await applySpamFeedback(env, user, messageId, "spam");
		});
		return allowedMessageIds;
	}
	if (action === "inbox") {
		const spamMessageIds = selectedMessages
			.filter((message) => message.status === "spam" && allowedMessageIds.includes(message.id))
			.map((message) => message.id);
		await updateInChunks(db, allowedMessageIds, values);
		if (spamMessageIds.length) {
			runAfterResponse("Not-spam training", async () => {
				for (const messageId of spamMessageIds) await applySpamFeedback(env, user, messageId, "ham");
			});
		}
		return allowedMessageIds;
	}

	await updateInChunks(db, allowedMessageIds, values);
	runAfterResponse("Audit log", () =>
		createAuditLogs(env, allowedMessageIds.map((messageId) => ({
			actorUserId: user.id,
			messageId,
			action: action === "read" || action === "unread" ? "email.read" : "email.delete",
			metadata: { bulkAction: action },
		}))));
	return allowedMessageIds;
}

async function updateInChunks(db: ReturnType<typeof getDb>, ids: string[], values: Partial<typeof messages.$inferInsert>): Promise<void> {
	const parts = Array.from({ length: Math.ceil(ids.length / 90) }, (_, index) => ids.slice(index * 90, index * 90 + 90));
	const updates = parts.map((part) => db.update(messages).set(values).where(inArray(messages.id, part)));
	if (updates.length) await db.batch(updates as [typeof updates[number], ...typeof updates]);
}
