import { currentSeq } from "./changes";
import { formatMailboxState, formatSeqState } from "./changes-utils";
import { forgetMemo, memoize } from "./context-utils";
import type { JmapContext } from "./types";
import { listAccessibleMailboxIdSet } from "./access";

/**
 * Opaque state strings, both read off the change log (migration 0033). The
 * Email state is the newest log sequence; Thread state shares it. Sequences
 * are global rather than per account: a client may see the state move and
 * fetch an empty change set, which is one indexed query, and in exchange the
 * log can be pruned from the front without per-account bookkeeping.
 *
 * Both are memoized on the request context, so a bundle of read methods
 * costs one sequence read and one access lookup instead of one per method.
 * Reusing a state read earlier in the request is safe: a later method can
 * only return data at least as new as that state, so the worst case is a
 * client asking for /changes since a state it is already past and getting
 * changes it has seen. The reverse, a state newer than the data, would lose
 * changes, and a first-read memo cannot produce it. Writes must not reuse
 * the memo for their `newState`, which is what `refreshEmailState` and
 * `refreshMailboxState` are for.
 */
export function getEmailState(ctx: JmapContext): Promise<string> {
	return memoize(ctx, "emailState", async () => formatSeqState(await memoizedSeq(ctx)));
}

/**
 * Mailbox counts live on Mailbox objects, so the mailbox state moves with the
 * email state; the digest of accessible mailbox ids catches mailboxes being
 * added, removed or shared, which the log does not record.
 */
export function getMailboxState(ctx: JmapContext): Promise<string> {
	return memoize(ctx, "mailboxState", async () => {
		const [seq, ids] = await Promise.all([memoizedSeq(ctx), listAccessibleMailboxIdSet(ctx)]);
		return formatMailboxState(seq, ids);
	});
}

/** The state after this request wrote: forgets every memoized read, then reads again. */
export function refreshEmailState(ctx: JmapContext): Promise<string> {
	forgetMemo(ctx);
	return getEmailState(ctx);
}

export function refreshMailboxState(ctx: JmapContext): Promise<string> {
	forgetMemo(ctx);
	return getMailboxState(ctx);
}

function memoizedSeq(ctx: JmapContext): Promise<number> {
	return memoize(ctx, "seq", () => currentSeq(ctx));
}
