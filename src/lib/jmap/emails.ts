import { and, asc, count, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { joinEmailAddressList } from "@/lib/email/address";
import { resolveThreadId } from "@/lib/email/threading";
import { storeMessageAttachments } from "@/lib/email/attachments";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { LIMITS, KEYWORD_FLAGGED, KEYWORD_SEEN } from "./constants";
import { JmapError, invalidArguments } from "./errors";
import { decodeBlobId, decodeMailboxRef, roleToStatus } from "./ids";
import { buildEmailObject, loadAttachmentsByMessage, pickEmailProperties } from "./email-objects";
import { chunkForParameters, emailNeedsAttachments, emailNeedsBodies } from "./email-objects-utils";
import { importFlags, parseReceivedAt, resolveDraftSender, resolveDraftsMailbox } from "./email-import-utils";
import { filterToSql, mailboxRefCondition, sortToSql } from "./email-query";
import { QUERY_WINDOW, describeEmailQueryShape, planEmailQueryPage, queryLimit, windowedPage } from "./email-query-utils";
import { currentSeq, exceedsFetchLimit, loadChangeRows, loadThreadMembers, locateHistory } from "./changes";
import { classifyChanges, classifyThreadChanges, diffQueryResults, formatSeqState, parseMaxChanges, takeChangeWindow } from "./changes-utils";
import { getEmailState, refreshEmailState } from "./state";
import { findJmapMailbox, listAccessibleMailboxIdSet, listJmapMailboxes } from "./access";
import { deleteUpload, readUpload, storeRawDraftMime } from "./blobs";
import type { Comparator, EmailAddressObject, Filter, JmapContext, JmapMethodHandler, JmapSetError, MailboxRef } from "./types";
import type { AttachmentContent } from "@/lib/email/attachment-types";

type MessageRow = typeof messages.$inferSelect;

/** The columns a draft row is made of, shared by `Email/set` create and `Email/import`. */
type DraftRow = {
	mailboxId: string;
	fromAddr: string;
	toAddr: string;
	ccAddr: string | null;
	bccAddr: string | null;
	subject: string | null;
	textBody: string | null;
	htmlBody: string | null;
	inReplyTo: string | null;
	references: string | null;
	read?: boolean;
	starred?: boolean;
	threadId?: string | null;
	providerMessageId?: string | null;
	rawR2Key?: string | null;
	createdAt?: Date;
};

/** Insert a draft and return its id. Drafts are outbound mail that has not been sent. */
async function insertDraft(ctx: JmapContext, row: DraftRow): Promise<string> {
	const id = newId("msg");
	await ctx.db.insert(messages).values({
		id,
		userId: ctx.auth.userId,
		mailboxId: row.mailboxId,
		direction: "outbound",
		fromAddr: row.fromAddr,
		toAddr: row.toAddr,
		ccAddr: row.ccAddr,
		bccAddr: row.bccAddr,
		subject: row.subject,
		snippet: buildSnippet(row.textBody, row.htmlBody),
		textBody: row.textBody,
		htmlBody: row.htmlBody,
		status: "draft",
		read: row.read ?? true,
		starred: row.starred ?? false,
		inReplyTo: row.inReplyTo,
		references: row.references,
		threadId: row.threadId ?? null,
		providerMessageId: row.providerMessageId ?? null,
		rawR2Key: row.rawR2Key ?? null,
		...(row.createdAt ? { createdAt: row.createdAt } : {}),
	});
	return id;
}

async function scope(ctx: JmapContext) {
	const ids = Array.from(await listAccessibleMailboxIdSet(ctx));
	return { ids, condition: ids.length ? inArray(messages.mailboxId, ids) : eq(messages.userId, ctx.auth.userId) };
}

const BODY_COLUMNS = new Set(["textBody", "htmlBody", "bodySize"]);

/**
 * The columns of a message row without its bodies. `htmlBody` is read only
 * for a row with no snippet, since that is all `preview` falls back to, and
 * `bodySize` is computed for a row the 0040 backfill has not reached, so a
 * light row answers every property but the body parts exactly as a full one.
 */
function lightMessageColumns() {
	const columns = getTableColumns(messages);
	return {
		...(Object.fromEntries(Object.entries(columns).filter(([key]) => !BODY_COLUMNS.has(key))) as Omit<typeof columns, "textBody" | "htmlBody" | "bodySize">),
		htmlBody: sql<string | null>`case when ${messages.snippet} is null then ${messages.htmlBody} end`,
		bodySize: sql<number>`coalesce(${messages.bodySize}, length(cast(coalesce(${messages.textBody}, '') as blob)) + length(cast(coalesce(${messages.htmlBody}, '') as blob)))`,
	};
}

/**
 * Rows for `ids` the account can see. With `bodies: false` the text and HTML
 * bodies stay in the database (see `lightMessageColumns`); the row's
 * `textBody` is then null. Ids are split into IN lists D1 can bind next to
 * the scope's own parameters; rows come back once each, in the order of
 * `ids`, whatever plan or chunking produced them.
 */
export async function loadMessages(ctx: JmapContext, ids: string[], options: { bodies?: boolean } = {}): Promise<MessageRow[]> {
	if (ids.length === 0) return [];
	const { ids: scopeIds } = await scope(ctx);
	// The same rows as scope(), but the unary + keeps the mailbox (or user) term
	// out of index selection, so SQLite looks each id up by primary key instead
	// of walking every message the account can see and filtering by id.
	const condition = scopeIds.length ? inArray(sql`+${messages.mailboxId}`, scopeIds) : sql`+${messages.userId} = ${ctx.auth.userId}`;
	const unique = Array.from(new Set(ids));
	const chunks = chunkForParameters(unique, Math.max(scopeIds.length, 1));
	let rows: MessageRow[];
	if (options.bodies === false) {
		const columns = lightMessageColumns();
		const found = await Promise.all(chunks.map((part) => ctx.db.select(columns).from(messages).where(and(condition, inArray(messages.id, part)))));
		rows = found.flat().map((row) => ({ ...row, textBody: null }));
	} else {
		rows = (await Promise.all(chunks.map((part) => ctx.db.select().from(messages).where(and(condition, inArray(messages.id, part)))))).flat();
	}
	const byId = new Map(rows.map((row) => [row.id, row]));
	return unique.flatMap((id) => byId.get(id) ?? []);
}

export const emailGet: JmapMethodHandler = async (ctx, args) => {
	const ids = args.ids as string[] | null | undefined;
	if (!ids) throw new JmapError("requestTooLarge", "Email/get needs an explicit list of ids");
	if (ids.length > LIMITS.maxObjectsInGet) throw new JmapError("requestTooLarge");
	const properties = args.properties as string[] | null | undefined;
	const fetchBodies = !!(args.fetchTextBodyValues || args.fetchHTMLBodyValues || args.fetchAllBodyValues);
	const maxBodyValueBytes = Number(args.maxBodyValueBytes ?? 0);
	const bodiesLoaded = emailNeedsBodies(properties, fetchBodies);

	const rows = await loadMessages(ctx, ids, { bodies: bodiesLoaded });
	const attachments = emailNeedsAttachments(properties) ? await loadAttachmentsByMessage(ctx, rows.map((row) => row.id)) : new Map();
	const found = new Set<string>();
	const list = rows.map((row) => {
		found.add(row.id);
		return pickEmailProperties(row, attachments.get(row.id) ?? [], properties, { fetchBodies, maxBodyValueBytes, bodiesLoaded });
	});
	return { accountId: ctx.accountId, state: await getEmailState(ctx), list, notFound: Array.from(new Set(ids)).filter((id) => !found.has(id)) };
};

/** The WHERE and ORDER BY an Email/query's filter and sort describe, within the accessible mailboxes. */
async function emailQueryParts(ctx: JmapContext, args: Record<string, unknown>) {
	const { ids: accessibleIds, condition } = await scope(ctx);
	const filter = filterToSql(args.filter as Filter | null | undefined, new Set(accessibleIds));
	const where = filter ? and(condition, filter) : condition;
	const order = sortToSql(args.sort as Comparator[] | null | undefined);
	return { where, order, condition, accessibleIds };
}

/**
 * The ordered id list a query describes, materialised up to QUERY_WINDOW.
 * Anchors, negative positions and collapseThreads need the whole list;
 * `Email/queryChanges` shares it so both see the same order.
 */
async function runEmailQuery(ctx: JmapContext, args: Record<string, unknown>) {
	const { where, order, condition, accessibleIds } = await emailQueryParts(ctx, args);
	const collapse = !!args.collapseThreads;
	const threadKey = sql<string>`coalesce(${messages.threadId}, ${messages.id})`;
	const allRows = await ctx.db
		.select({ id: messages.id, thread: threadKey })
		.from(messages)
		.where(where)
		.orderBy(...order)
		.limit(QUERY_WINDOW);
	let ordered = allRows.map((row) => row.id);
	if (collapse) {
		const seen = new Set<string>();
		ordered = allRows.filter((row) => (seen.has(row.thread) ? false : (seen.add(row.thread), true))).map((row) => row.id);
	}
	return { ordered, collapse, condition, accessibleIds };
}

/**
 * A plain page (no anchor, no collapseThreads, position >= 0) is read with
 * LIMIT/OFFSET in the same ORDER BY, so only that page leaves the database;
 * the total is a count(*) run only when asked for. Both stop at
 * QUERY_WINDOW, as the materialised list does.
 */
async function pageEmailQuery(ctx: JmapContext, args: Record<string, unknown>, page: { position: number; limit: number }) {
	const { where, order } = await emailQueryParts(ctx, args);
	const bounds = windowedPage(page);
	const [rows, counted] = await Promise.all([
		bounds ? ctx.db.select({ id: messages.id }).from(messages).where(where).orderBy(...order).limit(bounds.limit).offset(bounds.offset) : [],
		args.calculateTotal ? ctx.db.select({ total: count() }).from(messages).where(where) : null,
	]);
	return { ids: rows.map((row) => row.id), total: counted ? Math.min(counted[0]?.total ?? 0, QUERY_WINDOW) : undefined };
}

export const emailQuery: JmapMethodHandler = async (ctx, args) => {
	const page = planEmailQueryPage(args);
	console.debug("JMAP Email/query", JSON.stringify(describeEmailQueryShape(args, !!page)));
	if (page) {
		const { ids, total } = await pageEmailQuery(ctx, args, page);
		return {
			accountId: ctx.accountId,
			queryState: await getEmailState(ctx),
			canCalculateChanges: true,
			position: page.position,
			ids,
			...(total !== undefined ? { total } : {}),
		};
	}

	const { ordered } = await runEmailQuery(ctx, args);
	const limit = queryLimit(args.limit);
	let position = Number(args.position ?? 0);
	if (args.anchor) {
		const index = ordered.indexOf(String(args.anchor));
		if (index < 0) return { type: "anchorNotFound" };
		position = index + Number(args.anchorOffset ?? 0);
	}
	if (position < 0) position = Math.max(ordered.length + position, 0);
	const slice = ordered.slice(position, position + limit);

	return {
		accountId: ctx.accountId,
		queryState: await getEmailState(ctx),
		canCalculateChanges: true,
		position,
		ids: slice,
		...(args.calculateTotal ? { total: ordered.length } : {}),
	};
};

/**
 * The email log rows since a state, cut to `maxChanges` distinct keys, or
 * null when the state is not one the log can answer from (RFC 8620 §5.2).
 */
async function emailChangeWindow(ctx: JmapContext, args: Record<string, unknown>, keyOf: (row: { objectId: string; threadKey: string | null }) => string) {
	const maxChanges = parseMaxChanges(args.maxChanges);
	const history = await locateHistory(ctx, args.sinceState);
	if (history.status === "unknown") return null;
	if (history.status === "current") return { rows: [], since: history.seq, newSeq: history.seq, hasMore: false };
	const { ids } = await scope(ctx);
	let rows = await loadChangeRows(ctx, ids, history.since, history.current, "email");
	let truncated = false;
	if (exceedsFetchLimit(rows)) {
		rows = rows.slice(0, -1);
		truncated = true;
	}
	const window = takeChangeWindow(rows, keyOf, maxChanges, truncated ? rows[rows.length - 1].seq : history.current);
	return { ...window, since: history.since, hasMore: window.hasMore || truncated };
}

const CANNOT_CALCULATE = { type: "cannotCalculateChanges", description: "That state is older than the retained change history; run Email/query again." };

export const emailChanges: JmapMethodHandler = async (ctx, args) => {
	const window = await emailChangeWindow(ctx, args, (row) => row.objectId);
	if (!window) return CANNOT_CALCULATE;
	return {
		accountId: ctx.accountId,
		oldState: formatSeqState(window.since),
		newState: formatSeqState(window.newSeq),
		hasMoreChanges: window.hasMore,
		...classifyChanges(window.rows),
	};
};

/**
 * Email/queryChanges (RFC 8620 §5.6): every id that changed is reported as
 * removed and, when it still matches, added back at its current index. With
 * collapseThreads a new message can displace its thread's previous
 * representative without that message changing, so changes widen to whole
 * threads first.
 */
export const emailQueryChanges: JmapMethodHandler = async (ctx, args) => {
	const maxChanges = parseMaxChanges(args.maxChanges);
	const history = await locateHistory(ctx, args.sinceQueryState);
	if (history.status === "unknown") return CANNOT_CALCULATE;
	const { ordered, collapse, condition, accessibleIds } = await runEmailQuery(ctx, args);
	// The result list and the change rows are separate reads. If the log moved
	// between them the two do not describe the same moment, so rather than hand
	// out indexes that may already be stale the client is asked to query again.
	const current = history.status === "current" ? history.seq : history.current;
	if ((await currentSeq(ctx)) !== current) return CANNOT_CALCULATE;
	const total = args.calculateTotal ? { total: ordered.length } : {};
	if (history.status === "current") {
		return { accountId: ctx.accountId, oldQueryState: formatSeqState(current), newQueryState: formatSeqState(current), removed: [], added: [], ...total };
	}
	const rows = await loadChangeRows(ctx, accessibleIds, history.since, current, "email");
	if (exceedsFetchLimit(rows)) return { type: "tooManyChanges" };
	const changed = new Set(rows.map((row) => row.objectId));
	if (collapse) {
		const members = await loadThreadMembers(ctx, condition, Array.from(new Set(rows.map((row) => row.threadKey ?? row.objectId))));
		for (const ids of members.values()) for (const id of ids) changed.add(id);
	}
	// upToId only trims `added`: `removed` stays complete, so the bound is safe
	// whether or not the sort and filter are immutable (RFC 8620 §5.6).
	const { removed, added } = diffQueryResults(changed, ordered, typeof args.upToId === "string" ? args.upToId : null);
	if (maxChanges !== null && removed.length + added.length > maxChanges) return { type: "tooManyChanges" };
	return {
		accountId: ctx.accountId,
		oldQueryState: formatSeqState(history.since),
		newQueryState: formatSeqState(history.current),
		removed,
		added,
		...total,
	};
};

/** Where a patched `mailboxIds` puts the message: exactly one JMAP mailbox is supported. */
function targetFromMailboxIds(row: MessageRow, patch: Record<string, unknown>, accessible: Set<string>): { status?: string; folderId?: string | null } | { error: Record<string, unknown> } | null {
	let ids: string[] | null = null;
	if (patch.mailboxIds && typeof patch.mailboxIds === "object") {
		ids = Object.entries(patch.mailboxIds as Record<string, boolean>).filter(([, on]) => on).map(([id]) => id);
	} else {
		const current = new Set(Object.keys(buildEmailObject(row, [], { fetchBodies: false, maxBodyValueBytes: 0 }).mailboxIds));
		let touched = false;
		for (const [key, value] of Object.entries(patch)) {
			if (!key.startsWith("mailboxIds/")) continue;
			touched = true;
			const id = key.slice("mailboxIds/".length);
			if (value) current.add(id);
			else current.delete(id);
		}
		if (touched) ids = Array.from(current);
	}
	if (!ids) return null;
	if (ids.length !== 1) return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "A message belongs to exactly one mailbox" } };
	const ref: MailboxRef | null = decodeMailboxRef(ids[0]);
	if (!ref || !accessible.has(ref.mailboxId)) return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "Unknown mailbox" } };
	if (ref.mailboxId !== row.mailboxId) return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "Messages cannot move between accounts' mailboxes" } };
	if (ref.kind === "account") return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "Choose a folder or system mailbox" } };
	if (ref.kind === "folder") return { status: row.direction === "outbound" && row.status !== "draft" ? "sent" : "received", folderId: ref.folderId };
	if (ref.role === "sent" && row.direction === "inbound") return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "Received mail cannot be moved to Sent" } };
	return { status: roleToStatus(ref.role), folderId: null };
}

function keywordsFromPatch(patch: Record<string, unknown>): { read?: boolean; starred?: boolean } {
	const result: { read?: boolean; starred?: boolean } = {};
	const apply = (keyword: string, value: unknown) => {
		if (keyword === KEYWORD_SEEN) result.read = !!value;
		if (keyword === KEYWORD_FLAGGED) result.starred = !!value;
	};
	if (patch.keywords && typeof patch.keywords === "object") {
		const map = patch.keywords as Record<string, boolean>;
		result.read = !!map[KEYWORD_SEEN];
		result.starred = !!map[KEYWORD_FLAGGED];
	}
	for (const [key, value] of Object.entries(patch)) {
		if (key.startsWith("keywords/")) apply(key.slice("keywords/".length), value);
	}
	return result;
}

/** Drafts are the only thing a client creates; everything else is a flag or a move. */
async function createDraft(ctx: JmapContext, value: Record<string, unknown>, accessible: Set<string>) {
	const target = resolveDraftsMailbox(value.mailboxIds, accessible);
	if ("error" in target) return target;
	const mailbox = await findJmapMailbox(ctx, target.mailboxId);
	if (!mailbox) return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "Unknown mailbox" } };
	const from = (value.from as EmailAddressObject[] | undefined)?.[0]?.email;
	let sender: { fromAddr: string; mailboxId: string };
	try {
		sender = await getAuthorizedSenderAddress(ctx.env, { userId: ctx.auth.userId, from: resolveDraftSender(from, mailbox), mailboxId: target.mailboxId });
	} catch (error) {
		return { error: { type: "forbidden", description: error instanceof Error ? error.message : "Cannot send from that address" } };
	}
	const addressList = (list: unknown) =>
		Array.isArray(list) ? joinEmailAddressList((list as EmailAddressObject[]).map((item) => (item.name ? `"${item.name.replace(/"/g, '\\"')}" <${item.email}>` : item.email))) : "";
	const bodyValues = (value.bodyValues ?? {}) as Record<string, { value: string }>;
	const partText = (parts: unknown) => (Array.isArray(parts) && parts[0]?.partId ? bodyValues[parts[0].partId]?.value ?? "" : "");
	const text = partText(value.textBody);
	const html = partText(value.htmlBody);
	const references = Array.isArray(value.references) ? (value.references as string[]).join(" ") : null;

	const id = await insertDraft(ctx, {
		mailboxId: sender.mailboxId,
		fromAddr: sender.fromAddr,
		toAddr: addressList(value.to),
		ccAddr: addressList(value.cc) || null,
		bccAddr: addressList(value.bcc) || null,
		subject: typeof value.subject === "string" ? value.subject : null,
		textBody: text || null,
		htmlBody: html || null,
		inReplyTo: Array.isArray(value.inReplyTo) ? (value.inReplyTo as string[])[0] ?? null : null,
		references,
	});

	const uploads: AttachmentContent[] = [];
	for (const part of (value.attachments as Array<{ blobId?: string; name?: string; type?: string; disposition?: string; cid?: string }> | undefined) ?? []) {
		const blob = part.blobId ? decodeBlobId(part.blobId) : null;
		if (!blob || blob.kind !== "up") continue;
		const upload = await readUpload(ctx, blob.id);
		if (!upload) continue;
		uploads.push({ filename: part.name ?? upload.name ?? "attachment", type: part.type ?? upload.type, content: upload.content, disposition: part.disposition === "inline" ? ("inline" as const) : ("attachment" as const), contentId: part.cid ?? null });
	}
	if (uploads.length) {
		try {
			await storeMessageAttachments(ctx.env, id, uploads);
		} catch (error) {
			await ctx.db.delete(messages).where(eq(messages.id, id));
			return { error: { type: "tooLarge", description: error instanceof Error ? error.message : "Attachments rejected" } };
		}
	}
	return { id };
}

export const emailSet: JmapMethodHandler = async (ctx, args) => {
	const oldState = await getEmailState(ctx);
	if (args.ifInState && args.ifInState !== oldState) return { type: "stateMismatch" };
	const accessible = await listAccessibleMailboxIdSet(ctx);
	const writable = new Set((await listJmapMailboxes(ctx)).filter((row) => row.permission !== "read_only").map((row) => row.id));
	const created: Record<string, unknown> = {};
	const notCreated: Record<string, unknown> = {};
	const updated: Record<string, null> = {};
	const notUpdated: Record<string, unknown> = {};
	const destroyed: string[] = [];
	const notDestroyed: Record<string, unknown> = {};

	for (const [creationId, value] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
		const result = await createDraft(ctx, value, writable);
		if ("error" in result) {
			notCreated[creationId] = result.error;
			continue;
		}
		ctx.createdIds[creationId] = result.id;
		const [row] = await loadMessages(ctx, [result.id]);
		created[creationId] = row ? buildEmailObject(row, [], { fetchBodies: false, maxBodyValueBytes: 0 }) : { id: result.id };
	}

	const updates = Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>);
	const rows = await loadMessages(ctx, updates.map(([id]) => id));
	const byId = new Map(rows.map((row) => [row.id, row]));
	for (const [id, patch] of updates) {
		const row = byId.get(id);
		if (!row || !row.mailboxId) {
			notUpdated[id] = { type: "notFound" };
			continue;
		}
		if (!writable.has(row.mailboxId)) {
			notUpdated[id] = { type: "forbidden" };
			continue;
		}
		const move = targetFromMailboxIds(row, patch, accessible);
		if (move && "error" in move) {
			notUpdated[id] = move.error;
			continue;
		}
		const flags = keywordsFromPatch(patch);
		const set: Partial<MessageRow> = {};
		if (flags.read !== undefined) set.read = flags.read;
		if (flags.starred !== undefined) set.starred = flags.starred;
		if (move) {
			if (move.status !== undefined) set.status = move.status;
			if (move.folderId !== undefined) set.folderId = move.folderId;
		}
		if (Object.keys(set).length) await ctx.db.update(messages).set(set).where(eq(messages.id, id));
		updated[id] = null;
	}

	// JMAP destroy is permanent; Mailflare keeps a trash, so destroy moves there
	// and a second destroy from Trash deletes the row.
	const destroyIds = (args.destroy ?? []) as string[];
	const destroyRows = await loadMessages(ctx, destroyIds);
	const destroyById = new Map(destroyRows.map((row) => [row.id, row]));
	for (const id of destroyIds) {
		const row = destroyById.get(id);
		if (!row || !row.mailboxId) {
			notDestroyed[id] = { type: "notFound" };
			continue;
		}
		if (!writable.has(row.mailboxId)) {
			notDestroyed[id] = { type: "forbidden" };
			continue;
		}
		if (row.status === "trash" || row.status === "draft") await deleteMessageWithObjects(ctx.env, ctx.db, row.id, row.rawR2Key);
		else await ctx.db.update(messages).set({ status: "trash", folderId: null }).where(eq(messages.id, id));
		destroyed.push(id);
	}

	return { accountId: ctx.accountId, oldState, newState: await refreshEmailState(ctx), created, updated, destroyed, notCreated, notUpdated, notDestroyed };
};

/**
 * Import one uploaded `message/rfc822` blob as a draft (RFC 8621 §4.8). Clients
 * that compose MIME locally send by uploading it, importing it into Drafts and
 * then submitting it, so this is the first half of their send path. The raw
 * bytes are kept verbatim under `drafts/` and the parsed headers fill the
 * columns the rest of Mailflare reads, including `providerMessageId`, which is
 * what lets a client find its own draft again with a Message-ID header filter.
 * A message without a From header is filed under the mailbox's own address
 * rather than rejected: the sender is only settled at submission, so clients
 * routinely leave it out.
 */
async function importEmail(ctx: JmapContext, value: Record<string, unknown>, writable: Set<string>): Promise<{ id: string } | { error: JmapSetError }> {
	const target = resolveDraftsMailbox(value.mailboxIds, writable);
	if ("error" in target) return target;
	const mailbox = await findJmapMailbox(ctx, target.mailboxId);
	if (!mailbox) return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "Unknown mailbox" } };

	const blob = typeof value.blobId === "string" ? decodeBlobId(value.blobId) : null;
	if (!blob || blob.kind !== "up") return { error: { type: "blobNotFound", description: "blobId must name an upload from this account" } };
	const upload = await readUpload(ctx, blob.id);
	if (!upload) return { error: { type: "blobNotFound", description: "No such upload" } };
	if (upload.content.byteLength === 0) return { error: { type: "invalidEmail", description: "The blob is empty" } };
	if (upload.content.byteLength > LIMITS.maxSizeUpload) return { error: { type: "tooLarge", description: "The message exceeds maxSizeUpload" } };

	let parsed: Awaited<ReturnType<typeof parseRawMime>>;
	try {
		parsed = await parseRawMime(upload.content);
	} catch (error) {
		return { error: { type: "invalidEmail", description: error instanceof Error ? error.message : "The blob is not a MIME message" } };
	}

	let sender: { fromAddr: string; mailboxId: string };
	try {
		sender = await getAuthorizedSenderAddress(ctx.env, { userId: ctx.auth.userId, from: resolveDraftSender(parsed.fromAddr, mailbox), mailboxId: target.mailboxId });
	} catch (error) {
		return { error: { type: "forbidden", description: error instanceof Error ? error.message : "Cannot send from that address" } };
	}

	const flags = importFlags(value.keywords);
	const id = await insertDraft(ctx, {
		mailboxId: sender.mailboxId,
		fromAddr: sender.fromAddr,
		toAddr: parsed.toAddr ?? "",
		ccAddr: parsed.ccAddr,
		bccAddr: parsed.bccAddr,
		subject: parsed.subject,
		textBody: parsed.text,
		htmlBody: parsed.html,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references.length ? parsed.references.join(" ") : null,
		read: flags.read,
		starred: flags.starred,
		// Angle brackets are kept, as inbound rows store them.
		providerMessageId: parsed.messageId,
		threadId: await resolveThreadId(ctx.db, {
			mailboxId: sender.mailboxId,
			messageId: parsed.messageId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
		}),
		createdAt: parseReceivedAt(value.receivedAt) ?? parsed.date ?? new Date(),
	});

	// Nothing may be left half-imported, so the row and the bytes go together.
	let rawR2Key: string | null = null;
	try {
		rawR2Key = await storeRawDraftMime(ctx, id, upload.content);
		await ctx.db.update(messages).set({ rawR2Key }).where(eq(messages.id, id));
		if (parsed.attachments.length) await storeMessageAttachments(ctx.env, id, parsed.attachments);
	} catch (error) {
		try {
			await deleteMessageWithObjects(ctx.env, ctx.db, id, rawR2Key);
		} catch (cleanupError) {
			console.error(`Failed to clean up rejected Email/import draft ${id}`, cleanupError);
		}
		return { error: { type: "tooLarge", description: error instanceof Error ? error.message : "Attachments rejected" } };
	}
	// The bytes belong to the message now, so release the upload.
	try {
		await deleteUpload(ctx, blob.id);
	} catch (error) {
		// The import is already complete. Failing it here would make a client retry
		// and create a duplicate draft merely because temporary cleanup failed.
		console.warn(`Failed to delete claimed JMAP upload ${blob.id}`, error);
	}
	return { id };
}

export const emailImport: JmapMethodHandler = async (ctx, args) => {
	const oldState = await getEmailState(ctx);
	if (args.ifInState && args.ifInState !== oldState) return { type: "stateMismatch" };
	const emails = (args.emails ?? {}) as Record<string, Record<string, unknown>>;
	if (Object.keys(emails).length > LIMITS.maxObjectsInSet) throw new JmapError("requestTooLarge");
	const writable = new Set((await listJmapMailboxes(ctx)).filter((row) => row.permission !== "read_only").map((row) => row.id));
	const created: Record<string, unknown> = {};
	const notCreated: Record<string, unknown> = {};

	for (const [creationId, value] of Object.entries(emails)) {
		const result = await importEmail(ctx, value ?? {}, writable);
		if ("error" in result) {
			notCreated[creationId] = result.error;
			continue;
		}
		ctx.createdIds[creationId] = result.id;
		const [row] = await loadMessages(ctx, [result.id]);
		if (!row) {
			notCreated[creationId] = { type: "serverFail", description: "The imported message could not be read back" };
			continue;
		}
		// The same values Email/get would answer, so the client can act on them straight away.
		const object = buildEmailObject(row, (await loadAttachmentsByMessage(ctx, [row.id])).get(row.id) ?? [], { fetchBodies: false, maxBodyValueBytes: 0 });
		created[creationId] = { id: object.id, blobId: object.blobId, threadId: object.threadId, size: object.size };
	}

	return { accountId: ctx.accountId, oldState, newState: await refreshEmailState(ctx), created, notCreated };
};

export const emailUnsupported = (method: string): JmapMethodHandler => async () => ({ type: "unknownMethod", description: `${method} is not supported` });

/** Thread/get: every message sharing a thread key, oldest first. */
export const threadGet: JmapMethodHandler = async (ctx, args) => {
	const ids = args.ids as string[] | null | undefined;
	if (!ids) throw new JmapError("requestTooLarge", "Thread/get needs an explicit list of ids");
	const { condition } = await scope(ctx);
	const threadKey = sql<string>`coalesce(${messages.threadId}, ${messages.id})`;
	const rows = await ctx.db
		.select({ id: messages.id, thread: threadKey })
		.from(messages)
		.where(and(condition, inArray(threadKey, ids)))
		.orderBy(asc(messages.createdAt));
	const grouped = new Map<string, string[]>();
	for (const row of rows) grouped.set(row.thread, [...(grouped.get(row.thread) ?? []), row.id]);
	return {
		accountId: ctx.accountId,
		state: await getEmailState(ctx),
		list: Array.from(grouped, ([id, emailIds]) => ({ id, emailIds })),
		notFound: ids.filter((id) => !grouped.has(id)),
	};
};

export const threadChanges: JmapMethodHandler = async (ctx, args) => {
	const window = await emailChangeWindow(ctx, args, (row) => row.threadKey ?? row.objectId);
	if (!window) return CANNOT_CALCULATE;
	const { condition } = await scope(ctx);
	const keys = Array.from(new Set(window.rows.map((row) => row.threadKey ?? row.objectId)));
	const members = await loadThreadMembers(ctx, condition, keys);
	return {
		accountId: ctx.accountId,
		oldState: formatSeqState(window.since),
		newState: formatSeqState(window.newSeq),
		hasMoreChanges: window.hasMore,
		...classifyThreadChanges(window.rows, members),
	};
};

/** SearchSnippet/get: the subject and a body excerpt around the first match, with <mark> tags. */
export const searchSnippetGet: JmapMethodHandler = async (ctx, args) => {
	const ids = (args.emailIds as string[]) ?? [];
	const filter = (args.filter ?? {}) as { text?: string; subject?: string; body?: string };
	const term = (filter.text ?? filter.body ?? filter.subject ?? "").trim();
	const rows = await loadMessages(ctx, ids);
	const found = new Set<string>();
	const escape = (value: string) => value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);
	const highlight = (value: string | null) => {
		if (!value) return null;
		if (!term) return escape(value);
		const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
		return escape(value).replace(re, (match) => `<mark>${match}</mark>`);
	};
	const list = rows.map((row) => {
		found.add(row.id);
		const body = row.textBody ?? row.snippet ?? "";
		let excerpt: string | null = null;
		if (term) {
			const index = body.toLowerCase().indexOf(term.toLowerCase());
			if (index >= 0) excerpt = highlight(body.slice(Math.max(index - 80, 0), index + 160));
		}
		return { emailId: row.id, subject: highlight(row.subject), preview: excerpt };
	});
	return { accountId: ctx.accountId, list, notFound: ids.filter((id) => !found.has(id)) };
};

export { count, desc, mailboxRefCondition, invalidArguments };
