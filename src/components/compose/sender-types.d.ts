/** A From address outside the mailbox's fixed list: a catch-all address, typed or carried by a reply draft. */
export type ComposeCustomSender = {
	mailboxId: string;
	address: string;
};

export type ComposeSenderMailbox = {
	id: string;
	localPart: string;
	hostname: string;
	senderAddresses?: string[];
	catchAllHostnames?: string[];
};
