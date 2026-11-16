import type { BulkMessageAction } from "./types";

const allowedBulkActions = new Set<BulkMessageAction>([
	"archive",
	"trash",
	"spam",
	"read",
	"unread",
	"inbox",
	"folder",
]);

export function isAllowedBulkMessageAction(action: unknown): action is BulkMessageAction {
	return typeof action === "string" && allowedBulkActions.has(action as BulkMessageAction);
}

export function getStatusForBulkAction(action: BulkMessageAction): string | null {
	if (action === "archive") return "archived";
	if (action === "trash") return "trash";
	if (action === "spam") return "spam";
	if (action === "inbox") return "received";
	if (action === "folder") return "received";
	return null;
}

/**
 * The status "inbox" gives a message. Mail you sent goes back to Sent (or Drafts, if it was
 * never sent: only a delivered copy has a provider Message-ID), not into the Inbox.
 */
export function inboxStatusFor(message: { direction: string; providerMessageId: string | null }): string {
	if (message.direction !== "outbound") return "received";
	return message.providerMessageId ? "sent" : "draft";
}

export function getReadValueForBulkAction(action: BulkMessageAction): boolean | null {
	if (action === "read") return true;
	if (action === "unread") return false;
	return null;
}
