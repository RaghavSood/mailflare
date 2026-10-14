import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import type { DraftClaim } from "./draft-claim-types";
import { refusedClaimOutcome, staleClaimCutoff } from "./draft-claim-utils";

/**
 * Claim a draft for sending, so that exactly one request sends it. One
 * conditional UPDATE decides: of two requests racing for the same draft only
 * one changes the row. It touches only `send_claimed_at`, which no trigger
 * watches, and leaves the status alone, so the draft stays in Drafts while it
 * is sent and after a failed send.
 */
export async function claimDraftForSend(db: AppDatabase, userId: string, draftId: string, now = new Date()): Promise<DraftClaim> {
	const owned = and(eq(messages.id, draftId), eq(messages.userId, userId), eq(messages.status, "draft"));
	const [draft] = await db
		.update(messages)
		.set({ sendClaimedAt: now })
		.where(and(owned, or(isNull(messages.sendClaimedAt), lt(messages.sendClaimedAt, staleClaimCutoff(now)))))
		.returning({
			id: messages.id,
			htmlBody: messages.htmlBody,
			inReplyTo: messages.inReplyTo,
			references: messages.references,
			threadId: messages.threadId,
		});
	if (draft) return { outcome: "claimed", draft, claimedAt: now };
	const [existing] = await db.select({ id: messages.id }).from(messages).where(owned).limit(1);
	return { outcome: refusedClaimOutcome(!!existing) };
}

/**
 * Give a draft back after a send failed, so the user can try again. Only the
 * claim this request made is cleared. Never call it once the message went out:
 * a released draft can be sent a second time.
 */
export async function releaseDraftClaim(db: AppDatabase, draftId: string, claimedAt: Date): Promise<void> {
	await db
		.update(messages)
		.set({ sendClaimedAt: null })
		.where(and(eq(messages.id, draftId), eq(messages.sendClaimedAt, claimedAt)));
}
