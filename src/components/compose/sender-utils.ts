import type { ComposeCustomSender, ComposeSenderMailbox } from "./sender-types";

export const CUSTOM_SENDER_OPTION = "__custom__";

// Mirrors the server's dot-atom check in src/lib/email/sender.ts.
const SENDER_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

export function getMailboxSenderAddresses(mailbox: ComposeSenderMailbox): string[] {
	return mailbox.senderAddresses?.length ? mailbox.senderAddresses : [`${mailbox.localPart}@${mailbox.hostname}`];
}

/** The mailbox's own addresses plus the custom sender, when it belongs to this mailbox. */
export function getComposeSenderAddresses(
	mailbox: ComposeSenderMailbox | null,
	custom: ComposeCustomSender | null,
): string[] {
	if (!mailbox) return [];
	const addresses = getMailboxSenderAddresses(mailbox);
	if (!custom || custom.mailboxId !== mailbox.id || addresses.includes(custom.address)) return addresses;
	return [...addresses, custom.address];
}

/**
 * Checks a typed sender before the server does: a plain address on one of the
 * mailbox's catch-all domains. The server still decides, since a real mailbox
 * on that domain cannot be borrowed.
 */
export function validateCustomSender(value: string, mailbox: ComposeSenderMailbox): { address: string } | { error: string } {
	const address = value.trim().toLowerCase();
	if (!SENDER_PATTERN.test(address)) return { error: "Enter a full email address" };
	const hostname = address.slice(address.lastIndexOf("@") + 1);
	const hostnames = mailbox.catchAllHostnames ?? [];
	if (!hostnames.includes(hostname)) {
		return {
			error: hostnames.length
				? `Use an address on ${hostnames.join(", ")}`
				: "This mailbox has no catch-all domain to send from",
		};
	}
	return { address };
}
