import { eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { formatEmailAddress, getEmailAddress } from "@/lib/email/address";
import { resolveInboundAddress } from "@/lib/email/routing";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { resolveMailboxDisplayName } from "@/lib/profile/identity-utils";

export async function getAuthorizedSenderAddress(
	env: CloudflareEnv,
	input: {
		userId: string;
		from: string;
		mailboxId?: string | null;
	},
): Promise<{ fromAddr: string; mailboxId: string }> {
	if (!input.mailboxId) throw new Error("Mailbox is required");

	const db = getDb(env);
	const [mailbox] = await db
		.select({
		localPart: mailboxes.localPart,
		displayName: mailboxes.displayName,
		type: mailboxes.type,
		ownerName: users.name,
		ownerEmail: users.email,
		hostname: domains.hostname,
		domainId: mailboxes.domainId,
		useAllDomains: mailboxes.useAllDomains,
			id: mailboxes.id,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(eq(mailboxes.id, input.mailboxId))
		.limit(1);

	if (!mailbox) throw new Error("Mailbox not found");
	const [actor] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
	if (!actor || actor.disabled) throw new Error("Sender account not found");

	const access = await getMailboxAccessLevel(db, actor, mailbox.id);
	if (!access?.canSendOnBehalf) {
		throw new Error("You do not have permission to send from this mailbox");
	}

	const requestedAddress = getEmailAddress(input.from);
	const permittedAddresses = await getMailboxDomainAddresses(db, mailbox);
	if (
		!permittedAddresses.includes(requestedAddress.toLowerCase())
		&& !(await addressRoutesToMailbox(db, requestedAddress, mailbox.id))
	) {
		throw new Error("Sender address does not match the selected mailbox");
	}
	const senderAddress = requestedAddress.toLowerCase();
	// The primary mailbox sends under the account name; every other mailbox
	// sends under its own.
	const senderName = resolveMailboxDisplayName(mailbox, mailbox.ownerEmail, mailbox.ownerName);

	if (access.canSendAs) {
		return {
			fromAddr: formatEmailAddress(senderAddress, senderName),
			mailboxId: mailbox.id,
		};
	}

	const mailboxName = senderName || senderAddress;
	return {
		fromAddr: formatEmailAddress(senderAddress, `${actor.name} on behalf of ${mailboxName}`),
		mailboxId: mailbox.id,
	};
}

// Dot-atom addresses only: a custom sender is typed by the user and ends up in the From header.
const CUSTOM_SENDER_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/**
 * Whether mail to `address` is delivered into the mailbox: its own addresses and
 * aliases, or a catch-all rule that stores into it. A mailbox may send as any
 * address it receives for, which never includes another mailbox's real address
 * because real mailboxes win over catch-all rules in routing.
 */
export async function addressRoutesToMailbox(db: AppDatabase, address: string, mailboxId: string): Promise<boolean> {
	if (!CUSTOM_SENDER_PATTERN.test(address.trim())) return false;
	const decision = await resolveInboundAddress(db, address.trim());
	if (!decision?.mailbox || decision.action === "reject") return false;
	if (decision.action === "forward" && !decision.keepCopy) return false;
	return decision.mailbox.mailboxId === mailboxId;
}

/**
 * The address a reply to an inbound message should come from: the envelope
 * recipient it was delivered to, when the mailbox may send as it. Null leaves the
 * choice to the client (a To/Cc match, then the mailbox's primary address).
 */
export async function getReplyFromAddress(
	db: AppDatabase,
	message: { direction: string; mailboxId: string | null; deliveredTo: string | null },
	cache = new Map<string, boolean>(),
): Promise<string | null> {
	if (message.direction !== "inbound" || !message.mailboxId || !message.deliveredTo) return null;
	const address = message.deliveredTo.toLowerCase();
	const key = `${message.mailboxId}|${address}`;
	if (!cache.has(key)) cache.set(key, await addressRoutesToMailbox(db, address, message.mailboxId));
	return cache.get(key) ? address : null;
}
