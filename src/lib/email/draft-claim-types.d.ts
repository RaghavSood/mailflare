export type DraftClaimOutcome = "claimed" | "gone" | "sending";

/** The stored parts of a draft a send continues from. */
export type ClaimedDraft = {
	id: string;
	htmlBody: string | null;
	inReplyTo: string | null;
	references: string | null;
	threadId: string | null;
	composeKey: string | null;
};

export type DraftClaim =
	| { outcome: "claimed"; draft: ClaimedDraft; claimedAt: Date }
	| { outcome: "gone" | "sending" };
