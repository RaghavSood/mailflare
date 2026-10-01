import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, messages } from "@/db/schema";
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
 * Unread counts for the navigation in one pass over the mailbox: inbox and spam
 * count unread messages, drafts count drafts, folders count unread.
 */
export async function loadCounts(env: CloudflareEnv, scopeMailboxIds: string[]): Promise<V2Counts> {
	const empty: V2Counts = { inbox: 0, spam: 0, drafts: 0, snoozed: 0, folders: new Map() };
	if (scopeMailboxIds.length === 0) return empty;
	const db = getDb(env);
	const now = Math.floor(Date.now() / 1000);
	const unreadInbound = sql`${messages.direction} = 'inbound' and ${messages.read} = 0`;
	const notSnoozed = sql`(${messages.snoozedUntil} is null or ${messages.snoozedUntil} <= ${now})`;
	const totalsQuery = db
		.select({
			inbox: sql<number>`coalesce(sum(case when ${unreadInbound} and ${messages.status} = 'received' and ${messages.folderId} is null and ${notSnoozed} then 1 else 0 end), 0)`,
			spam: sql<number>`coalesce(sum(case when ${unreadInbound} and ${messages.status} = 'spam' then 1 else 0 end), 0)`,
			drafts: sql<number>`coalesce(sum(case when ${messages.status} = 'draft' then 1 else 0 end), 0)`,
			snoozed: sql<number>`coalesce(sum(case when ${messages.status} = 'received' and ${messages.snoozedUntil} > ${now} then 1 else 0 end), 0)`,
		})
		.from(messages)
		.where(inArray(messages.mailboxId, scopeMailboxIds));
	const folderQuery = db
		.select({
			folderId: messages.folderId,
			unread: sql<number>`coalesce(sum(case when ${unreadInbound} then 1 else 0 end), 0)`,
		})
		.from(messages)
		.where(and(inArray(messages.mailboxId, scopeMailboxIds), isNotNull(messages.folderId)))
		.groupBy(messages.folderId);
	const [[totals], folderRows] = await Promise.all([totalsQuery, folderQuery]);
	return {
		inbox: Number(totals?.inbox ?? 0),
		spam: Number(totals?.spam ?? 0),
		drafts: Number(totals?.drafts ?? 0),
		snoozed: Number(totals?.snoozed ?? 0),
		folders: new Map(folderRows.filter((row) => row.folderId).map((row) => [row.folderId as string, Number(row.unread)])),
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
