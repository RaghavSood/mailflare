import { getEmailAddressList, normalizeEmailAddress } from "@/lib/email/address";
import type { V2ViewKey } from "../types";

export function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
	return out;
}

type ParticipantMember = {
	fromAddr: string;
	direction: "inbound" | "outbound";
	read: boolean;
	createdAt: Date;
};

/**
 * The names a conversation row shows, Gmail-style: its senders in the order
 * they wrote, "me" for the mailbox's own messages, at most three with the
 * first kept. In Sent and Drafts the row names who the mail went to instead.
 */
export function buildParticipants(
	members: ParticipantMember[],
	options: { view: V2ViewKey; nameFor: (address: string) => string; toAddr: string },
): Array<{ name: string; unread: boolean }> {
	if (options.view === "sent" || options.view === "drafts") {
		const recipients = getEmailAddressList(options.toAddr).map(options.nameFor);
		return [{ name: recipients.length ? `To: ${recipients.slice(0, 3).join(", ")}` : "(no recipients)", unread: false }];
	}
	const ordered = [...members].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
	const seen = new Map<string, { name: string; unread: boolean }>();
	for (const member of ordered) {
		const key = member.direction === "outbound" ? "me" : normalizeEmailAddress(member.fromAddr);
		const unread = member.direction === "inbound" && !member.read;
		const existing = seen.get(key);
		if (existing) {
			// Move to the end: the list reads as "who spoke last".
			seen.delete(key);
			seen.set(key, { ...existing, unread: existing.unread || unread });
			continue;
		}
		seen.set(key, { name: member.direction === "outbound" ? "me" : options.nameFor(member.fromAddr), unread });
	}
	const names = [...seen.values()];
	if (names.length <= 3) return names;
	return [names[0], ...names.slice(-2)];
}
