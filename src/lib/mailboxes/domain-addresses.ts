import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxAliases, mailboxes, routingRules } from "@/db/schema";
import { deleteEmailRoutingRuleForAddress, ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { composeMailboxDomainAddresses } from "./domain-addresses-utils";
import type { MailboxDomainAddressInput } from "./domain-addresses-types";

export async function getMailboxAliasAddresses(
	db: AppDatabase,
	mailboxId: string,
): Promise<string[]> {
	const aliases = await db
		.select({ localPart: mailboxAliases.localPart, hostname: domains.hostname })
		.from(mailboxAliases)
		.innerJoin(domains, eq(mailboxAliases.domainId, domains.id))
		.where(eq(mailboxAliases.mailboxId, mailboxId));
	return aliases.map((alias) => `${alias.localPart}@${alias.hostname}`.toLowerCase());
}

/**
 * Domains whose catch-all (domain-scope store, or forward that keeps a copy) rules
 * deliver into the mailbox. It may send as addresses there that are not real
 * mailboxes; the composer offers a free-form sender for these domains.
 */
export async function getMailboxCatchAllHostnames(db: AppDatabase, mailboxId: string): Promise<string[]> {
	const rows = await db
		.select({ hostname: domains.hostname, action: routingRules.action, keepCopy: routingRules.keepCopy })
		.from(routingRules)
		.innerJoin(domains, eq(routingRules.domainId, domains.id))
		.where(
			and(
				eq(routingRules.mailboxId, mailboxId),
				eq(routingRules.scope, "domain"),
				eq(routingRules.enabled, true),
				eq(domains.status, "active"),
			),
		);
	return [
		...new Set(
			rows
				.filter((row) => row.action === "store" || (row.action === "forward" && row.keepCopy))
				.map((row) => row.hostname.toLowerCase()),
		),
	];
}

export async function getMailboxDomainAddresses(
	db: AppDatabase,
	mailbox: MailboxDomainAddressInput,
): Promise<string[]> {
	const [primaryDomain] = await db
		.select({ hostname: domains.hostname, userId: domains.userId })
		.from(domains)
		.where(eq(domains.id, mailbox.domainId))
		.limit(1);
	if (!primaryDomain) return [];

	const aliasAddresses = await getMailboxAliasAddresses(db, mailbox.id);
	if (!mailbox.useAllDomains) {
		return composeMailboxDomainAddresses({ mailbox, primaryHostname: primaryDomain.hostname, aliasAddresses, availableDomains: [], assignedMailboxes: [], assignedAliases: [] });
	}

	const availableDomains = await db
		.select({ id: domains.id, hostname: domains.hostname })
		.from(domains)
		.where(and(eq(domains.userId, primaryDomain.userId), eq(domains.status, "active")));
	const assignedMailboxes = await db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart })
		.from(mailboxes);
	const assignedAliases = await db
		.select({
			mailboxId: mailboxAliases.mailboxId,
			domainId: mailboxAliases.domainId,
			localPart: mailboxAliases.localPart,
		})
		.from(mailboxAliases);
	return composeMailboxDomainAddresses({ mailbox, primaryHostname: primaryDomain.hostname, aliasAddresses, availableDomains, assignedMailboxes, assignedAliases });
}

/**
 * `getMailboxDomainAddresses` for many mailboxes at once, keyed by mailbox id,
 * in at most five queries however many mailboxes there are (two when none uses
 * all domains). Each statement is the one-mailbox query with `IN` in place of
 * `=`, so rows come back in the same per-mailbox order; the claimed local parts
 * are read only on the domains they could exclude. A mailbox whose domain is
 * gone maps to an empty list.
 */
export async function getMailboxDomainAddressesByMailbox(
	db: AppDatabase,
	list: MailboxDomainAddressInput[],
): Promise<Map<string, string[]>> {
	const result = new Map<string, string[]>();
	if (list.length === 0) return result;

	const primaryDomains = await db
		.select({ id: domains.id, hostname: domains.hostname, userId: domains.userId })
		.from(domains)
		.where(inArray(domains.id, [...new Set(list.map((mailbox) => mailbox.domainId))]));
	const primaryById = new Map(primaryDomains.map((domain) => [domain.id, domain]));
	const aliasRows = await db
		.select({ mailboxId: mailboxAliases.mailboxId, localPart: mailboxAliases.localPart, hostname: domains.hostname })
		.from(mailboxAliases)
		.innerJoin(domains, eq(mailboxAliases.domainId, domains.id))
		.where(inArray(mailboxAliases.mailboxId, list.map((mailbox) => mailbox.id)));
	const aliasesByMailbox = groupBy(aliasRows, (row) => row.mailboxId);

	const ownerIds = [...new Set(list.filter((mailbox) => mailbox.useAllDomains).map((mailbox) => primaryById.get(mailbox.domainId)?.userId).filter((id): id is string => !!id))];
	const availableDomains = ownerIds.length
		? await db
				.select({ id: domains.id, hostname: domains.hostname, userId: domains.userId })
				.from(domains)
				.where(and(inArray(domains.userId, ownerIds), eq(domains.status, "active")))
		: [];
	const availableByOwner = groupBy(availableDomains, (domain) => domain.userId);
	const availableIds = availableDomains.map((domain) => domain.id);
	const assignedMailboxes = availableIds.length
		? await db
				.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart })
				.from(mailboxes)
				.where(inArray(mailboxes.domainId, availableIds))
		: [];
	const assignedAliases = availableIds.length
		? await db
				.select({ mailboxId: mailboxAliases.mailboxId, domainId: mailboxAliases.domainId, localPart: mailboxAliases.localPart })
				.from(mailboxAliases)
				.where(inArray(mailboxAliases.domainId, availableIds))
		: [];

	for (const mailbox of list) {
		const primary = primaryById.get(mailbox.domainId);
		if (!primary) {
			result.set(mailbox.id, []);
			continue;
		}
		result.set(
			mailbox.id,
			composeMailboxDomainAddresses({
				mailbox,
				primaryHostname: primary.hostname,
				aliasAddresses: (aliasesByMailbox.get(mailbox.id) ?? []).map((alias) => `${alias.localPart}@${alias.hostname}`.toLowerCase()),
				availableDomains: mailbox.useAllDomains ? (availableByOwner.get(primary.userId) ?? []) : [],
				assignedMailboxes,
				assignedAliases,
			}),
		);
	}
	return result;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const group = groups.get(key(row));
		if (group) group.push(row);
		else groups.set(key(row), [row]);
	}
	return groups;
}

export async function ensureMailboxDomainRouting(
	env: CloudflareEnv,
	db: AppDatabase,
	mailbox: MailboxDomainAddressInput,
): Promise<void> {
	const addresses = await getMailboxDomainAddresses(db, mailbox);
	if (addresses.length === 0) return;
	const [primaryDomain] = await db
		.select({ userId: domains.userId })
		.from(domains)
		.where(eq(domains.id, mailbox.domainId))
		.limit(1);
	if (!primaryDomain) return;
	const availableDomains = await db
		.select({ hostname: domains.hostname, zoneId: domains.zoneId })
		.from(domains)
		.where(eq(domains.userId, primaryDomain.userId));
	const domainsByHostname = new Map(availableDomains.map((domain) => [domain.hostname.toLowerCase(), domain]));

	await Promise.all(
		addresses.map(async (address) => {
			const hostname = address.slice(address.lastIndexOf("@") + 1);
			const domain = domainsByHostname.get(hostname);
			if (domain) await ensureEmailRoutingRuleToWorker(env, domain.zoneId, address);
		}),
	);
}

export async function removeMailboxDomainRouting(
	env: CloudflareEnv,
	db: AppDatabase,
	mailbox: MailboxDomainAddressInput,
): Promise<void> {
	const addresses = await getMailboxDomainAddresses(db, mailbox);
	if (addresses.length === 0) return;
	const [primaryDomain] = await db
		.select({ userId: domains.userId })
		.from(domains)
		.where(eq(domains.id, mailbox.domainId))
		.limit(1);
	if (!primaryDomain) return;
	const availableDomains = await db
		.select({ hostname: domains.hostname, zoneId: domains.zoneId })
		.from(domains)
		.where(eq(domains.userId, primaryDomain.userId));
	const domainsByHostname = new Map(availableDomains.map((domain) => [domain.hostname.toLowerCase(), domain]));

	await Promise.all(
		addresses.map(async (address) => {
			const hostname = address.slice(address.lastIndexOf("@") + 1);
			const domain = domainsByHostname.get(hostname);
			if (domain) await deleteEmailRoutingRuleForAddress(env, domain.zoneId, address);
		}),
	);
}
