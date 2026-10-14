import type { DraftClaimOutcome } from "./draft-claim-types";

/**
 * How long a send holds its draft. A claim is released when sending fails;
 * one older than this belongs to a request that died without releasing it,
 * and the next send may take it over. Well past any real send, so a slow send
 * is never overtaken.
 */
export const DRAFT_SEND_CLAIM_TTL_MS = 5 * 60 * 1000;

/** Claims stamped before this are stale at `now`. */
export function staleClaimCutoff(now: Date): Date {
	return new Date(now.getTime() - DRAFT_SEND_CLAIM_TTL_MS);
}

/**
 * Why a claim was refused. Only the request whose conditional update changed
 * the row may send; any other finds the draft gone (sent or discarded) or
 * still a draft, which means another request is sending it right now.
 */
export function refusedClaimOutcome(stillDraft: boolean): Exclude<DraftClaimOutcome, "claimed"> {
	return stillDraft ? "sending" : "gone";
}
