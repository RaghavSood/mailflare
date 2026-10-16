import { and, asc, eq, gt, inArray, isNull, lt, lte, max, min, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { jmapChangeLog, messages } from "@/db/schema";
import { parseSeqState } from "./changes-utils";
import type { ChangeHistory, ChangeLogRow } from "./changes-types";
import type { JmapContext } from "./types";

/** Rows fetched per /changes call; past this the reply says hasMoreChanges. */
const FETCH_LIMIT = 2000;
/** Days of history kept. A client further behind than this resyncs in full. */
const RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** D1 binds at most 100 parameters per statement. */
const IN_CHUNK = 90;

let lastPruneAt = 0;

/** The newest sequence in the log, or 0 before anything has changed. */
export async function currentSeq(ctx: JmapContext): Promise<number> {
	const [row] = await ctx.db.select({ seq: max(jmapChangeLog.seq) }).from(jmapChangeLog);
	return Number(row?.seq ?? 0);
}

/**
 * Whether the history a client asks for is still in the log. Pruning removes
 * a contiguous prefix, so anything at or after `min(seq) - 1` is complete.
 */
export async function locateHistory(ctx: JmapContext, sinceState: unknown): Promise<ChangeHistory> {
	const since = parseSeqState(sinceState);
	if (since === null) return { status: "unknown" };
	const [row] = await ctx.db.select({ newest: max(jmapChangeLog.seq), oldest: min(jmapChangeLog.seq) }).from(jmapChangeLog);
	const current = Number(row?.newest ?? 0);
	if (since > current) return { status: "unknown" };
	if (since === current) return { status: "current", seq: current };
	const oldest = Number(row?.oldest ?? 0);
	if (since < oldest - 1) return { status: "unknown" };
	return { status: "available", since, current };
}

/** The log rows this account can see, matching `scope()` in emails.ts. */
function accountCondition(ctx: JmapContext, mailboxIds: string[]): SQL {
	const owner = eq(jmapChangeLog.userId, ctx.auth.userId);
	return mailboxIds.length ? or(inArray(jmapChangeLog.mailboxId, mailboxIds), owner)! : owner;
}

/**
 * Log rows in `(since, upper]` for this account, oldest first. The upper
 * bound is the sequence the caller will report as its new state, so a change
 * committed while the request runs waits for the next call instead of being
 * delivered under a state that does not cover it.
 */
export async function loadChangeRows(ctx: JmapContext, mailboxIds: string[], since: number, upper: number, type: "email" | "mailbox" | null): Promise<ChangeLogRow[]> {
	const conditions = [gt(jmapChangeLog.seq, since), lte(jmapChangeLog.seq, upper), accountCondition(ctx, mailboxIds)];
	if (type) conditions.push(eq(jmapChangeLog.type, type));
	const rows = await ctx.db
		.select({ seq: jmapChangeLog.seq, type: jmapChangeLog.type, objectId: jmapChangeLog.objectId, mailboxId: jmapChangeLog.mailboxId, threadKey: jmapChangeLog.threadKey, kind: jmapChangeLog.kind })
		.from(jmapChangeLog)
		.where(and(...conditions))
		.orderBy(asc(jmapChangeLog.seq))
		.limit(FETCH_LIMIT + 1);
	return rows.map((row) => ({ ...row, seq: Number(row.seq) }));
}

/** True when `loadChangeRows` hit its cap, in which case the last row must be dropped and hasMoreChanges set. */
export function exceedsFetchLimit(rows: ChangeLogRow[]): boolean {
	return rows.length > FETCH_LIMIT;
}

/** Current member ids of each thread key, indexed so the lookup never scans. */
export async function loadThreadMembers(ctx: JmapContext, scope: SQL, threadKeys: string[]): Promise<Map<string, string[]>> {
	const result = new Map<string, string[]>();
	for (let index = 0; index < threadKeys.length; index += IN_CHUNK) {
		const chunk = threadKeys.slice(index, index + IN_CHUNK);
		const rows = await ctx.db
			.select({ id: messages.id, thread: sql<string>`coalesce(${messages.threadId}, ${messages.id})` })
			.from(messages)
			.where(and(scope, or(inArray(messages.threadId, chunk), and(isNull(messages.threadId), inArray(messages.id, chunk)))))
			.orderBy(asc(messages.createdAt));
		for (const row of rows) result.set(row.thread, [...(result.get(row.thread) ?? []), row.id]);
	}
	return result;
}

/**
 * Drop history older than the retention window, at most once an hour per
 * isolate. Only a prefix is removed and the newest row always stays, so
 * `locateHistory` can tell a stale client apart from a quiet server.
 */
export async function pruneChangeLog(ctx: JmapContext, now = Date.now()): Promise<void> {
	if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
	lastPruneAt = now;
	const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000);
	const [row] = await ctx.db
		.select({ newest: max(jmapChangeLog.seq), expired: max(sql<number>`case when ${jmapChangeLog.createdAt} < ${Math.floor(cutoff.getTime() / 1000)} then ${jmapChangeLog.seq} end`) })
		.from(jmapChangeLog);
	const newest = Number(row?.newest ?? 0);
	const expired = Number(row?.expired ?? 0);
	if (!expired) return;
	await ctx.db.delete(jmapChangeLog).where(and(lt(jmapChangeLog.seq, newest), lt(jmapChangeLog.seq, expired + 1)));
}

/** Test hook: forget the last prune time so the next call runs. */
export function resetPruneTimer(): void {
	lastPruneAt = 0;
}
