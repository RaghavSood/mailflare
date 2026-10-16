import { inArray } from "drizzle-orm";
import { folders } from "@/db/schema";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { getMailboxDomainAddressesByMailbox } from "@/lib/mailboxes/domain-addresses";
import { memoize } from "./context-utils";
import type { AccessibleMailbox, JmapContext } from "./types";

/**
 * Every Mailflare mailbox the key's user can read, in a JMAP-shaped record.
 * Memoized for the request: the set of accessible mailboxes changes only
 * through the dashboard (creating, disabling or sharing a mailbox), never
 * through a JMAP method, so every handler in a request may share one lookup.
 * The owned-mailboxes query, the license check and (with sharing enabled)
 * the shared-mailboxes query otherwise ran once per method.
 */
export function listJmapMailboxes(ctx: JmapContext): Promise<AccessibleMailbox[]> {
	return memoize(ctx, "mailboxes", async () => {
		const rows = await listAccessibleMailboxes(ctx.db, ctx.auth.user);
		return rows.map((row) => ({
			id: row.id,
			userId: row.userId,
			domainId: row.domainId,
			localPart: row.localPart,
			hostname: row.hostname,
			displayName: row.displayName,
			permission: row.permission,
			type: row.type,
			isPrimary: row.isPrimary,
			useAllDomains: row.useAllDomains,
		}));
	});
}

/** One accessible mailbox by Mailflare id, or null when the key cannot see it. */
export async function findJmapMailbox(ctx: JmapContext, mailboxId: string): Promise<AccessibleMailbox | null> {
	return (await listJmapMailboxes(ctx)).find((row) => row.id === mailboxId) ?? null;
}

export function listAccessibleMailboxIdSet(ctx: JmapContext): Promise<Set<string>> {
	return memoize(ctx, "mailboxIds", async () => new Set((await listJmapMailboxes(ctx)).map((row) => row.id)));
}

/** User folders for a set of mailboxes, keyed by mailbox id. */
export async function listFoldersByMailbox(ctx: JmapContext, mailboxIds: string[]): Promise<Map<string, Array<{ id: string; name: string }>>> {
	const result = new Map<string, Array<{ id: string; name: string }>>();
	if (mailboxIds.length === 0) return result;
	const rows = await ctx.db
		.select({ id: folders.id, mailboxId: folders.mailboxId, name: folders.name })
		.from(folders)
		.where(inArray(folders.mailboxId, mailboxIds));
	for (const row of rows) {
		const list = result.get(row.mailboxId) ?? [];
		list.push({ id: row.id, name: row.name });
		result.set(row.mailboxId, list);
	}
	return result;
}

/** Addresses each mailbox may send from, for Identity objects, keyed by mailbox id; one batch of queries for all of them. */
export function listSendableAddresses(ctx: JmapContext, list: AccessibleMailbox[]): Promise<Map<string, string[]>> {
	return getMailboxDomainAddressesByMailbox(ctx.db, list);
}
