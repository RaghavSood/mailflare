import { and, count, countDistinct, desc, eq, gt, inArray, isNull, lte, max, notInArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { getContactDisplayNameMap } from "@/lib/contacts/service";
import { getEmailAddressList, getEmailDisplayName, normalizeEmailAddress } from "@/lib/email/address";
import { buildSearchConditions } from "@/lib/search/conditions";
import type { V2ListPage, V2ListRow, V2Mailbox, V2ViewKey } from "../types";
import { buildParticipants, chunk } from "./list-utils";

export const V2_PAGE_SIZE = 50;

/** Messages never threaded (older rows, drafts) stand alone under their own id. */
export const threadKey = sql<string>`coalesce(${messages.threadId}, ${messages.id})`;

/**
 * The filter for a view, Gmail-style: Inbox is unarchived, unfiled, unsnoozed
 * mail; Starred and All mail leave out drafts, spam and trash; a search looks
 * through All mail unless it is run inside another view.
 */
export function viewConditions(
	view: V2ViewKey,
	options: { scopeMailboxIds: string[]; folderId?: string | null; q?: string | null },
): SQL[] {
	const now = new Date();
	const conditions: SQL[] = [inArray(messages.mailboxId, options.scopeMailboxIds)];
	const everyday = notInArray(messages.status, ["draft", "spam", "trash"]);
	switch (view) {
		case "inbox":
			conditions.push(
				eq(messages.direction, "inbound"),
				eq(messages.status, "received"),
				isNull(messages.folderId),
				or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, now))!,
			);
			break;
		case "starred":
			conditions.push(eq(messages.starred, true), everyday);
			break;
		case "snoozed":
			conditions.push(eq(messages.status, "received"), gt(messages.snoozedUntil, now));
			break;
		case "sent":
			conditions.push(eq(messages.direction, "outbound"), inArray(messages.status, ["sent", "queued"]));
			break;
		case "drafts":
			conditions.push(eq(messages.status, "draft"));
			break;
		case "archive":
			conditions.push(eq(messages.status, "archived"));
			break;
		case "spam":
			conditions.push(eq(messages.status, "spam"));
			break;
		case "trash":
			conditions.push(eq(messages.status, "trash"));
			break;
		case "folder":
			conditions.push(eq(messages.folderId, options.folderId ?? ""), everyday);
			break;
		case "all":
		case "search":
			conditions.push(everyday);
			break;
	}
	const q = options.q?.trim();
	if (q) conditions.push(...buildSearchConditions(q));
	return conditions;
}

const rowColumns = {
	id: messages.id,
	threadId: messages.threadId,
	mailboxId: messages.mailboxId,
	direction: messages.direction,
	status: messages.status,
	folderId: messages.folderId,
	fromAddr: messages.fromAddr,
	toAddr: messages.toAddr,
	subject: messages.subject,
	snippet: messages.snippet,
	createdAt: messages.createdAt,
	read: messages.read,
	starred: messages.starred,
	snoozedUntil: messages.snoozedUntil,
	userId: messages.userId,
};

type RepRow = {
	id: string;
	threadId: string | null;
	mailboxId: string | null;
	direction: "inbound" | "outbound";
	status: string;
	folderId: string | null;
	fromAddr: string;
	toAddr: string;
	subject: string | null;
	snippet: string | null;
	createdAt: Date;
	read: boolean;
	starred: boolean;
	snoozedUntil: Date | null;
	userId: string;
};

/**
 * One page of conversations, newest first, each represented by its newest
 * message in the view. Drafts are listed one per draft.
 */
export async function loadList(
	env: CloudflareEnv,
	input: {
		view: V2ViewKey;
		scopeMailboxIds: string[];
		mailboxes: V2Mailbox[];
		folderId?: string | null;
		q?: string | null;
		offset: number;
		limit: number;
	},
): Promise<V2ListPage> {
	const page = Math.floor(input.offset / input.limit) + 1;
	if (input.scopeMailboxIds.length === 0) return { rows: [], total: 0, page, pageSize: input.limit };
	const db = getDb(env);
	const where = and(...viewConditions(input.view, input));
	const grouped = input.view !== "drafts";

	let total: number;
	let reps: RepRow[];
	const selectReps = () => db.select(rowColumns).from(messages);
	if (grouped) {
		const [totalRow] = await db.select({ total: countDistinct(threadKey) }).from(messages).where(where);
		total = totalRow?.total ?? 0;
		const latest = db
			.select({ tid: threadKey.as("tid"), latest: max(messages.createdAt).as("latest") })
			.from(messages)
			.where(where)
			.groupBy(threadKey)
			.as("latest_per_thread");
		const joined = await selectReps()
			.innerJoin(latest, and(eq(threadKey, latest.tid), eq(messages.createdAt, latest.latest)))
			.where(where)
			.orderBy(desc(messages.createdAt), desc(messages.id))
			.limit(input.limit)
			.offset(input.offset);
		const seen = new Set<string>();
		reps = joined.filter((row) => {
			const key = row.threadId ?? row.id;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	} else {
		const [totalRow] = await db.select({ total: count() }).from(messages).where(where);
		total = totalRow?.total ?? 0;
		reps = await selectReps().where(where).orderBy(desc(messages.createdAt), desc(messages.id)).limit(input.limit).offset(input.offset);
	}
	if (reps.length === 0) return { rows: [], total, page, pageSize: input.limit };

	const keys = reps.map((row) => row.threadId ?? row.id);
	// The messages each row stands for in this view, and the whole conversation
	// (minus drafts and trash) for counts, names, stars and unread state.
	const inView = grouped
		? await db.select({ id: messages.id, key: threadKey }).from(messages).where(and(where, inArray(threadKey, keys)))
		: reps.map((row) => ({ id: row.id, key: row.threadId ?? row.id }));
	const conversation = grouped
		? await db
				.select({
					key: threadKey,
					id: messages.id,
					fromAddr: messages.fromAddr,
					direction: messages.direction,
					read: messages.read,
					starred: messages.starred,
					createdAt: messages.createdAt,
					status: messages.status,
				})
				.from(messages)
				.where(
					and(
						inArray(messages.mailboxId, input.scopeMailboxIds),
						inArray(threadKey, keys),
						notInArray(messages.status, input.view === "trash" ? ["draft"] : input.view === "spam" ? ["draft", "trash"] : ["draft", "trash", "spam"]),
					),
				)
		: [];
	const memberIds = new Map<string, string[]>();
	for (const member of inView) memberIds.set(member.key, [...(memberIds.get(member.key) ?? []), member.id]);
	const withAttachments = new Set<string>();
	// D1 binds at most 100 parameters per query.
	for (const ids of chunk(inView.map((member) => member.id), 90)) {
		const found = await db
			.selectDistinct({ messageId: messageAttachments.messageId })
			.from(messageAttachments)
			.where(and(inArray(messageAttachments.messageId, ids), eq(messageAttachments.disposition, "attachment")));
		for (const row of found) withAttachments.add(row.messageId);
	}

	const names = new Map<string, string>();
	for (const ownerId of new Set(reps.map((row) => row.userId))) {
		const addresses = new Set([
			...reps.filter((row) => row.userId === ownerId).flatMap((row) => [row.fromAddr, ...getEmailAddressList(row.toAddr).slice(0, 3)]),
			...conversation.map((member) => member.fromAddr),
		].map(normalizeEmailAddress));
		for (const group of chunk([...addresses], 90)) {
			for (const [address, name] of await getContactDisplayNameMap(env, ownerId, group)) names.set(address, name);
		}
	}
	const nameFor = (address: string) => names.get(normalizeEmailAddress(address)) ?? getEmailDisplayName(address);

	const rows: V2ListRow[] = reps.map((rep) => {
		const key = rep.threadId ?? rep.id;
		const members = conversation.filter((member) => member.key === key);
		const ids = memberIds.get(key) ?? [rep.id];
		const viewMembers = grouped ? members.filter((member) => ids.includes(member.id)) : [];
		const unread = grouped
			? viewMembers.some((member) => member.direction === "inbound" && !member.read)
			: rep.direction === "inbound" && !rep.read;
		return {
			id: rep.id,
			threadKey: key,
			mailboxId: rep.mailboxId,
			direction: rep.direction,
			status: rep.status,
			folderId: rep.folderId,
			fromAddr: rep.fromAddr,
			toAddr: rep.toAddr,
			subject: rep.subject,
			snippet: rep.snippet,
			createdAt: rep.createdAt,
			read: !unread,
			starred: grouped ? members.some((member) => member.starred) || rep.starred : rep.starred,
			snoozedUntil: rep.snoozedUntil,
			hasAttachments: ids.some((id) => withAttachments.has(id)),
			count: Math.max(members.length, 1),
			unread,
			participants: buildParticipants(
				grouped && members.length ? members : [{ ...rep, key }],
				{ view: input.view, nameFor, toAddr: rep.toAddr },
			),
			memberIds: ids,
		};
	});
	return { rows, total, page, pageSize: input.limit };
}

/**
 * Row ids around a list position and the list's size, for an open
 * conversation's newer/older buttons; no names or counts are loaded.
 */
export async function loadListWindow(
	env: CloudflareEnv,
	input: { view: V2ViewKey; scopeMailboxIds: string[]; folderId?: string | null; q?: string | null; index: number },
): Promise<{ newer: string | null; older: string | null; total: number }> {
	if (input.scopeMailboxIds.length === 0) return { newer: null, older: null, total: 0 };
	const db = getDb(env);
	const where = and(...viewConditions(input.view, input));
	const offset = Math.max(input.index - 1, 0);
	const [totalRow] = await db.select({ total: countDistinct(threadKey) }).from(messages).where(where);
	const latest = db
		.select({ tid: threadKey.as("tid"), latest: max(messages.createdAt).as("latest") })
		.from(messages)
		.where(where)
		.groupBy(threadKey)
		.as("latest_per_thread");
	const rows = await db
		.select({ id: messages.id, threadId: messages.threadId })
		.from(messages)
		.innerJoin(latest, and(eq(threadKey, latest.tid), eq(messages.createdAt, latest.latest)))
		.where(where)
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(4)
		.offset(offset);
	const seen = new Set<string>();
	const ids = rows.filter((row) => {
		const key = row.threadId ?? row.id;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).map((row) => row.id);
	const at = input.index - offset;
	return {
		newer: input.index > 0 ? ids[at - 1] ?? null : null,
		older: ids[at + 1] ?? null,
		total: totalRow?.total ?? 0,
	};
}
