import { and, asc, count, eq, gt, inArray, like, lte, ne, or } from "drizzle-orm";
import { getDb } from "@/db";
import { conversationViews, folders, messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { hasMailboxPermission, listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { getMailboxCatchAllHostnames, getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { tracksAccountIdentity } from "@/lib/profile/identity-utils";
import type { V2Counts, V2Folder, V2Mailbox } from "../types";

/**
 * The user's mailboxes. Sender addresses cost several queries per mailbox, so
 * they are left empty here and filled by `loadSenders` only where a composer
 * is rendered.
 */
export async function loadMailboxes(env: CloudflareEnv, user: SessionUser): Promise<V2Mailbox[]> {
	const rows = await listAccessibleMailboxes(getDb(env), user);
	return rows.map((mailbox) => ({
		id: mailbox.id,
		address: `${mailbox.localPart}@${mailbox.hostname}`,
		userId: mailbox.userId,
		name: mailbox.userId === user.id && tracksAccountIdentity(mailbox, user.email)
			? user.name
			: mailbox.displayName ?? mailbox.localPart,
		signature: mailbox.signature ?? null,
		canSend: hasMailboxPermission(mailbox.permission, "send_on_behalf"),
		canManage: hasMailboxPermission(mailbox.permission, "full_access"),
		senderAddresses: [],
		catchAllHostnames: [],
		domainId: mailbox.domainId,
		localPart: mailbox.localPart,
		useAllDomains: mailbox.useAllDomains,
	}));
}

/** Fill in the addresses each sendable mailbox may send as. */
export async function loadSenders(env: CloudflareEnv, mailboxes: V2Mailbox[]): Promise<V2Mailbox[]> {
	const db = getDb(env);
	return Promise.all(
		mailboxes.map(async (mailbox) => {
			if (!mailbox.canSend || mailbox.senderAddresses.length) return mailbox;
			const [senderAddresses, catchAllHostnames] = await Promise.all([
				getMailboxDomainAddresses(db, { id: mailbox.id, domainId: mailbox.domainId, localPart: mailbox.localPart, useAllDomains: mailbox.useAllDomains }),
				getMailboxCatchAllHostnames(db, mailbox.id),
			]);
			return { ...mailbox, senderAddresses, catchAllHostnames };
		}),
	);
}

/**
 * Unread counts for the navigation, Gmail-style: conversations with unread
 * mail in Inbox, Spam and each folder (from the partial index over unread
 * conversation_views rows), and the number of drafts.
 */
export async function loadCounts(env: CloudflareEnv, scopeMailboxIds: string[]): Promise<V2Counts> {
	const empty: V2Counts = { inbox: 0, spam: 0, drafts: 0, folders: new Map() };
	if (scopeMailboxIds.length === 0) return empty;
	const db = getDb(env);
	const now = Math.floor(Date.now() / 1000);
	const [unreadRows, [drafts]] = await db.batch([
		db
			.select({ view: conversationViews.view, count: count() })
			.from(conversationViews)
			.where(and(
				inArray(conversationViews.mailboxId, scopeMailboxIds),
				gt(conversationViews.unreadCount, 0),
				or(inArray(conversationViews.view, ["inbox", "spam"]), like(conversationViews.view, "folder:%")),
				or(ne(conversationViews.view, "inbox"), lte(conversationViews.snoozeMin, now)),
			))
			.groupBy(conversationViews.view),
		db
			.select({ count: count() })
			.from(messages)
			.where(and(inArray(messages.mailboxId, scopeMailboxIds), eq(messages.status, "draft"))),
	]);
	const byView = new Map(unreadRows.map((row) => [row.view, Number(row.count)]));
	return {
		inbox: byView.get("inbox") ?? 0,
		spam: byView.get("spam") ?? 0,
		drafts: Number(drafts?.count ?? 0),
		folders: new Map([...byView].filter(([view]) => view.startsWith("folder:")).map(([view, value]) => [view.slice(7), value])),
	};
}

export async function loadFolders(env: CloudflareEnv, scopeMailboxIds: string[], counts: V2Counts): Promise<V2Folder[]> {
	if (scopeMailboxIds.length === 0) return [];
	const rows = await getDb(env)
		.select({ id: folders.id, name: folders.name, color: folders.color, mailboxId: folders.mailboxId })
		.from(folders)
		.where(inArray(folders.mailboxId, scopeMailboxIds))
		.orderBy(asc(folders.name));
	return rows.map((row) => ({ ...row, unread: counts.folders.get(row.id) ?? 0 }));
}

export async function loadFolder(env: CloudflareEnv, folderId: string, scopeMailboxIds: string[]) {
	if (scopeMailboxIds.length === 0) return null;
	const [folder] = await getDb(env)
		.select({ id: folders.id, name: folders.name, mailboxId: folders.mailboxId })
		.from(folders)
		.where(and(eq(folders.id, folderId), inArray(folders.mailboxId, scopeMailboxIds)))
		.limit(1);
	return folder ?? null;
}
