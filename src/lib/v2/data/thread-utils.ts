import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { V2ViewKey } from "../types";

export type ActionCandidate = {
	id: string;
	key: string;
	direction: "inbound" | "outbound";
	status: string;
	folderId: string | null;
	read: boolean;
	starred: boolean;
	createdAt: Date;
};

export type UndoEntry = { id: string; status: string; folderId: string | null; read: boolean };

const RESTORABLE_STATUSES = new Set(["received", "sent", "queued", "draft", "archived", "spam", "trash"]);

/**
 * Which messages of the chosen conversations an action changes. Archive,
 * spam and moves only make sense for mail that was received; marking unread
 * marks the newest received message, as Gmail does; trash takes everything
 * not already there.
 */
export function pickActionTargets(
	candidates: ActionCandidate[],
	action: BulkMessageAction | "star" | "unstar" | "snooze",
	view: V2ViewKey,
): ActionCandidate[] {
	const inbound = candidates.filter((candidate) => candidate.direction === "inbound");
	switch (action) {
		case "archive":
			return inbound.filter((candidate) => candidate.status === "received");
		case "trash":
			return candidates.filter((candidate) => candidate.status !== "trash");
		case "spam":
			return inbound.filter((candidate) => candidate.status !== "spam");
		case "inbox":
			return inbound.filter((candidate) => candidate.status !== "received" || candidate.folderId !== null);
		case "folder":
			return view === "drafts" ? [] : inbound;
		case "read":
			return inbound.filter((candidate) => !candidate.read);
		case "unread": {
			const latest = new Map<string, ActionCandidate>();
			for (const candidate of inbound) {
				const current = latest.get(candidate.key);
				if (!current || candidate.createdAt > current.createdAt) latest.set(candidate.key, candidate);
			}
			return [...latest.values()].filter((candidate) => candidate.read);
		}
		default:
			return candidates;
	}
}

/** Undo data comes back from the browser, so only well-formed entries are restored. */
export function parseUndoEntries(value: string | null | undefined): UndoEntry[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((entry): entry is UndoEntry =>
				!!entry
				&& typeof entry === "object"
				&& typeof (entry as UndoEntry).id === "string"
				&& /^[A-Za-z0-9_-]{1,64}$/.test((entry as UndoEntry).id)
				&& RESTORABLE_STATUSES.has((entry as UndoEntry).status)
				&& ((entry as UndoEntry).folderId === null || /^[A-Za-z0-9_-]{1,64}$/.test(String((entry as UndoEntry).folderId)))
				&& typeof (entry as UndoEntry).read === "boolean")
			.slice(0, 500);
	} catch {
		return [];
	}
}
