export type MailboxDomainAddressInput = {
	id: string;
	domainId: string;
	localPart: string;
	useAllDomains: boolean;
};

/**
 * Rows `composeMailboxDomainAddresses` builds one mailbox's addresses from.
 * The last three are only read when the mailbox has `useAllDomains`: the
 * owner's active domains, and the mailboxes and aliases that may already
 * claim the same local part on them.
 */
export type MailboxDomainAddressSources = {
	mailbox: MailboxDomainAddressInput;
	primaryHostname: string;
	/** Lower-cased `local@host` of each alias, in the order they were read. */
	aliasAddresses: string[];
	availableDomains: Array<{ id: string; hostname: string }>;
	assignedMailboxes: Array<{ id: string; domainId: string; localPart: string }>;
	assignedAliases: Array<{ mailboxId: string; domainId: string; localPart: string }>;
};
