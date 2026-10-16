import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import type { MailboxDomainAddressSources } from "./domain-addresses-types";

/**
 * The addresses a mailbox may send from, in order: its own address, then (with
 * `useAllDomains`) the same local part on the owner's other active domains
 * that no other mailbox or alias already claims, then its aliases. Duplicates
 * keep their first position. Pure, so the one-mailbox and the batched loaders
 * in domain-addresses.ts give the same answer from the same rows.
 */
export function composeMailboxDomainAddresses(sources: MailboxDomainAddressSources): string[] {
	const { mailbox, primaryHostname, aliasAddresses } = sources;
	const primaryAddress = `${mailbox.localPart}@${primaryHostname}`.toLowerCase();
	if (!mailbox.useAllDomains) {
		return [...new Set([primaryAddress, ...aliasAddresses])];
	}

	const normalizedLocalPart = normalizeRecipientLocalPart(mailbox.localPart);
	const assignedDomainIds = new Set(
		[
			...sources.assignedMailboxes.filter(
				(item) => item.id !== mailbox.id && normalizeRecipientLocalPart(item.localPart) === normalizedLocalPart,
			),
			...sources.assignedAliases.filter(
				(item) => item.mailboxId !== mailbox.id && normalizeRecipientLocalPart(item.localPart) === normalizedLocalPart,
			),
		].map((item) => item.domainId),
	);

	return [
		...new Set([
			primaryAddress,
			...sources.availableDomains
				.filter((domain) => domain.id !== mailbox.domainId && !assignedDomainIds.has(domain.id))
				.map((domain) => `${mailbox.localPart}@${domain.hostname}`.toLowerCase()),
			...aliasAddresses,
		]),
	];
}
