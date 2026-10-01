import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { SessionUser } from "@/lib/auth/types";
import { getContactDisplayNameMap } from "@/lib/contacts/service";
import { normalizeEmailAddress } from "@/lib/email/address";
import { applyMessageAction } from "@/lib/messages/actions";
import type { V2Thread, V2ThreadMessage, V2ViewKey } from "../types";
import { chunk } from "./list-utils";
import { threadKey, viewConditions } from "./list";
import { pickActionTargets, type ActionCandidate, type UndoEntry } from "./thread-utils";

/** Statuses a conversation hides unless it is opened from that folder. */
function hiddenStatuses(view: V2ViewKey): string[] {
	if (view === "trash") return ["draft"];
	if (view === "spam") return ["draft", "trash"];
	return ["draft", "trash", "spam"];
}

/**
 * The conversation `messageId` belongs to, oldest first, with bodies and
 * attachments. Trash and spam only show when the conversation was opened
 * from those folders, as in Gmail.
 */
export async function loadThread(
	env: CloudflareEnv,
	input: { messageId: string; view: V2ViewKey; scopeMailboxIds: string[] },
): Promise<V2Thread | null> {
	if (input.scopeMailboxIds.length === 0) return null;
	const db = getDb(env);
	const [anchor] = await db
		.select({ id: messages.id, threadId: messages.threadId, mailboxId: messages.mailboxId, status: messages.status })
		.from(messages)
		.where(and(eq(messages.id, input.messageId), inArray(messages.mailboxId, input.scopeMailboxIds)))
		.limit(1);
	if (!anchor?.mailboxId) return null;
	const key = anchor.threadId ?? anchor.id;
	const hidden = hiddenStatuses(input.view).filter((status) => status !== anchor.status);
	const rows = await db
		.select({
			id: messages.id,
			userId: messages.userId,
			mailboxId: messages.mailboxId,
			direction: messages.direction,
			status: messages.status,
			folderId: messages.folderId,
			fromAddr: messages.fromAddr,
			toAddr: messages.toAddr,
			ccAddr: messages.ccAddr,
			bccAddr: messages.bccAddr,
			deliveredTo: messages.deliveredTo,
			subject: messages.subject,
			snippet: messages.snippet,
			textBody: messages.textBody,
			htmlBody: messages.htmlBody,
			createdAt: messages.createdAt,
			read: messages.read,
			starred: messages.starred,
			providerMessageId: messages.providerMessageId,
			references: messages.references,
			threadId: messages.threadId,
		})
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, anchor.mailboxId),
				eq(threadKey, key),
				hidden.length ? notInArray(messages.status, hidden) : undefined,
			),
		)
		.orderBy(asc(messages.createdAt))
		.limit(200);
	if (rows.length === 0) return null;

	const attachments = new Map<string, V2ThreadMessage["attachments"]>();
	for (const ids of chunk(rows.map((row) => row.id), 90)) {
		const found = await db
			.select({
				id: messageAttachments.id,
				messageId: messageAttachments.messageId,
				filename: messageAttachments.filename,
				contentType: messageAttachments.contentType,
				size: messageAttachments.size,
				disposition: messageAttachments.disposition,
				contentId: messageAttachments.contentId,
			})
			.from(messageAttachments)
			.where(inArray(messageAttachments.messageId, ids));
		for (const { messageId, ...attachment } of found) {
			attachments.set(messageId, [...(attachments.get(messageId) ?? []), attachment]);
		}
	}
	const names = await getContactDisplayNameMap(env, rows[0].userId, rows.map((row) => row.fromAddr));
	const threadMessages: V2ThreadMessage[] = rows.map(({ userId: _userId, ...row }) => ({
		...row,
		fromName: names.get(normalizeEmailAddress(row.fromAddr)) ?? null,
		attachments: attachments.get(row.id) ?? [],
	}));
	return {
		key,
		subject: [...threadMessages].reverse().find((message) => message.subject)?.subject ?? null,
		messages: threadMessages,
		mailboxId: anchor.mailboxId,
	};
}

/**
 * The messages an action on these conversations should change, and their state
 * beforehand for undo. In a list, a row covers the conversation's messages in
 * that view; trash always takes the whole visible conversation, as in Gmail.
 */
export async function resolveActionTargets(
	env: CloudflareEnv,
	input: {
		ids: string[];
		action: BulkMessageAction | "star" | "unstar" | "snooze";
		view: V2ViewKey;
		scopeMailboxIds: string[];
		folderId?: string | null;
		q?: string | null;
		/** True when acting from an open conversation rather than a list. */
		conversation: boolean;
	},
): Promise<ActionCandidate[]> {
	if (input.ids.length === 0 || input.scopeMailboxIds.length === 0) return [];
	const db = getDb(env);
	const keys = new Set<string>();
	for (const ids of chunk(input.ids, 90)) {
		const found = await db
			.select({ key: threadKey })
			.from(messages)
			.where(and(inArray(messages.id, ids), inArray(messages.mailboxId, input.scopeMailboxIds)));
		for (const row of found) keys.add(row.key);
	}
	if (keys.size === 0) return [];
	const scoped = input.view === "drafts"
		? viewConditions("drafts", input)
		: input.conversation || input.action === "trash"
			? [inArray(messages.mailboxId, input.scopeMailboxIds), notInArray(messages.status, hiddenStatuses(input.view))]
			: viewConditions(input.view, input);
	const candidates: ActionCandidate[] = [];
	for (const group of chunk([...keys], 80)) {
		const rows = await db
			.select({
				id: messages.id,
				key: threadKey,
				direction: messages.direction,
				status: messages.status,
				folderId: messages.folderId,
				read: messages.read,
				starred: messages.starred,
				createdAt: messages.createdAt,
			})
			.from(messages)
			.where(and(...scoped, inArray(threadKey, group)));
		candidates.push(...rows);
	}
	return pickActionTargets(candidates, input.action, input.view);
}

export async function runAction(
	env: CloudflareEnv,
	user: SessionUser,
	targets: ActionCandidate[],
	action: BulkMessageAction,
	folderId?: string | null,
): Promise<UndoEntry[]> {
	if (targets.length === 0) return [];
	const undo = targets.map((target) => ({ id: target.id, status: target.status, folderId: target.folderId, read: target.read }));
	const changed = new Set<string>();
	for (const ids of chunk(targets.map((target) => target.id), 90)) {
		for (const id of await applyMessageAction(env, user, { messageIds: ids, action, folderId })) changed.add(id);
	}
	return undo.filter((entry) => changed.has(entry.id));
}

/**
 * The mailboxes a signed-in user may change, from the access already loaded for
 * the request. Writes filter by these in SQL instead of re-checking access per
 * message.
 */
export type WriteScope = { readable: string[]; manageable: string[] };

/** Star the newest message of each conversation, or clear every star in them. */
export async function setConversationStar(env: CloudflareEnv, scope: WriteScope, targets: ActionCandidate[], starred: boolean): Promise<void> {
	const newest = new Map<string, ActionCandidate>();
	for (const target of targets) {
		const current = newest.get(target.key);
		if (!current || target.createdAt > current.createdAt) newest.set(target.key, target);
	}
	const ids = starred
		? [...newest.values()].map((target) => target.id)
		: targets.filter((target) => target.starred).map((target) => target.id);
	await updateScoped(env, scope.readable, ids, { starred });
}

export async function setSnooze(env: CloudflareEnv, scope: WriteScope, targets: ActionCandidate[], until: Date | null): Promise<void> {
	const ids = targets.filter((target) => target.direction === "inbound" && target.status === "received").map((target) => target.id);
	await updateScoped(env, scope.manageable, ids, { snoozedUntil: until });
}

/** Put messages back the way an undo entry recorded them. */
export async function restoreMessages(env: CloudflareEnv, scope: WriteScope, entries: UndoEntry[]): Promise<void> {
	const groups = new Map<string, UndoEntry[]>();
	for (const entry of entries) {
		const key = JSON.stringify([entry.status, entry.folderId, entry.read]);
		groups.set(key, [...(groups.get(key) ?? []), entry]);
	}
	for (const group of groups.values()) {
		const { status, folderId, read } = group[0];
		await updateScoped(env, scope.manageable, group.map((entry) => entry.id), { status, folderId, read });
	}
}

/** Mark the unread inbound messages of an opened conversation read. */
export async function markRead(env: CloudflareEnv, scope: WriteScope, ids: string[]): Promise<void> {
	await updateScoped(env, scope.readable, ids, { read: true }, eq(messages.read, false));
}

export async function markUnreadFrom(env: CloudflareEnv, scope: WriteScope, ids: string[]): Promise<void> {
	await updateScoped(env, scope.readable, ids, { read: false }, eq(messages.direction, "inbound"));
}

/** One UPDATE per chunk of ids, limited to the given mailboxes, sent as a single batch. */
async function updateScoped(
	env: CloudflareEnv,
	mailboxIds: string[],
	ids: string[],
	values: Partial<typeof messages.$inferInsert>,
	extra?: ReturnType<typeof eq>,
): Promise<void> {
	if (ids.length === 0 || mailboxIds.length === 0) return;
	const db = getDb(env);
	const updates = chunk(ids, 80).map((part) =>
		db.update(messages).set(values).where(and(inArray(messages.id, part), inArray(messages.mailboxId, mailboxIds), extra)));
	await db.batch(updates as [typeof updates[number], ...typeof updates]);
}
