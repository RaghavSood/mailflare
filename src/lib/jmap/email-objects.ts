import { inArray } from "drizzle-orm";
import { messageAttachments, messages } from "@/db/schema";
import { parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { KEYWORD_DRAFT, KEYWORD_FLAGGED, KEYWORD_SEEN } from "./constants";
import { attachmentBlobId, encodeMailboxRef, messageBlobId, statusToRole } from "./ids";
import { chunkForParameters } from "./email-objects-utils";
import type { EmailAddressObject, EmailBodyPart, JmapContext } from "./types";

type MessageRow = typeof messages.$inferSelect;
type AttachmentRow = typeof messageAttachments.$inferSelect;

export function toAddressObjects(value: string | null | undefined): EmailAddressObject[] | null {
	const entries = splitEmailAddressList(value);
	if (entries.length === 0) return null;
	return entries.map((entry) => {
		const parts = parseEmailAddressParts(entry);
		return { name: parts.name, email: parts.address };
	});
}

export function mailboxIdsFor(row: MessageRow): Record<string, boolean> {
	if (!row.mailboxId) return {};
	if (row.folderId) return { [encodeMailboxRef({ kind: "folder", mailboxId: row.mailboxId, folderId: row.folderId })]: true };
	const role = statusToRole(row.status);
	return role ? { [encodeMailboxRef({ kind: "role", mailboxId: row.mailboxId, role })]: true } : {};
}

export function keywordsFor(row: MessageRow): Record<string, boolean> {
	const keywords: Record<string, boolean> = {};
	if (row.read || row.direction === "outbound") keywords[KEYWORD_SEEN] = true;
	if (row.starred) keywords[KEYWORD_FLAGGED] = true;
	if (row.status === "draft") keywords[KEYWORD_DRAFT] = true;
	return keywords;
}

export function threadIdFor(row: Pick<MessageRow, "id" | "threadId">): string {
	return row.threadId ?? row.id;
}

function stripBrackets(value: string | null): string | null {
	const trimmed = value?.trim().replace(/^<|>$/g, "");
	return trimmed || null;
}

function bodyPart(partId: string, type: string, size: number): EmailBodyPart {
	return { partId, blobId: null, size, headers: [], name: null, type, charset: "utf-8", disposition: null, cid: null, language: null, location: null };
}

function attachmentPart(attachment: AttachmentRow): EmailBodyPart {
	return {
		partId: null,
		blobId: attachmentBlobId(attachment.id),
		size: attachment.size,
		headers: [],
		name: attachment.filename,
		type: attachment.contentType,
		charset: null,
		disposition: attachment.disposition,
		cid: attachment.contentId ? attachment.contentId.replace(/^<|>$/g, "") : null,
		language: null,
		location: null,
	};
}

type EmailObjectOptions = {
	fetchBodies: boolean;
	maxBodyValueBytes: number;
	/**
	 * False when the row was read without `text_body` and `html_body` (see
	 * `emailNeedsBodies`): `size` then comes from `body_size`, and `htmlBody`
	 * holds the HTML only when there is no snippet, which is all `preview` reads.
	 */
	bodiesLoaded?: boolean;
};

/** The parts built from the stored bodies, with each part's UTF-8 byte size. */
function bodyParts(row: MessageRow, attachments: AttachmentRow[], inline: AttachmentRow[], attached: AttachmentRow[], options: EmailObjectOptions) {
	if (options.bodiesLoaded === false) throw new Error("Email body parts need the message bodies; load them with the row");
	const text = row.textBody ?? "";
	const html = row.htmlBody ?? "";
	const textSize = new TextEncoder().encode(text).length;
	const htmlSize = new TextEncoder().encode(html).length;
	const textPart = text ? bodyPart("1", "text/plain", textSize) : null;
	const htmlPart = html ? bodyPart("2", "text/html", htmlSize) : null;

	let structure: EmailBodyPart;
	const parts = [textPart, htmlPart].filter((part): part is EmailBodyPart => !!part);
	const alternative: EmailBodyPart | null =
		parts.length > 1
			? { partId: null, blobId: null, size: textSize + htmlSize, name: null, type: "multipart/alternative", charset: null, disposition: null, cid: null, language: null, location: null, subParts: parts }
			: parts[0] ?? bodyPart("1", "text/plain", 0);
	if (attachments.length > 0) {
		structure = { partId: null, blobId: null, size: 0, name: null, type: "multipart/mixed", charset: null, disposition: null, cid: null, language: null, location: null, subParts: [alternative, ...inline.map(attachmentPart), ...attached.map(attachmentPart)] };
	} else {
		structure = alternative;
	}

	const bodyValues: Record<string, { value: string; isEncodingProblem: boolean; isTruncated: boolean }> = {};
	if (options.fetchBodies) {
		const clip = (value: string) => {
			const limit = options.maxBodyValueBytes;
			if (!limit || value.length <= limit) return { value, isEncodingProblem: false, isTruncated: false };
			return { value: value.slice(0, limit), isEncodingProblem: false, isTruncated: true };
		};
		if (textPart) bodyValues["1"] = clip(text);
		if (htmlPart) bodyValues["2"] = clip(html);
	}
	return { textSize, htmlSize, textPart, htmlPart, structure, bodyValues };
}

/**
 * One reader per Email property (RFC 8621 §4.1), in the order a full object
 * lists them, so a fetch of a few properties computes only those. Bodies are
 * the parsed text and HTML Mailflare keeps; attachments become parts with blob
 * ids the download endpoint understands.
 */
function emailReaders(row: MessageRow, attachments: AttachmentRow[], options: EmailObjectOptions) {
	const inline = attachments.filter((item) => item.disposition === "inline");
	const attached = attachments.filter((item) => item.disposition !== "inline");
	let parts: ReturnType<typeof bodyParts> | null = null;
	const body = () => (parts ??= bodyParts(row, attachments, inline, attached, options));
	const from = () => toAddressObjects(row.fromAddr);
	const sentAt = () => row.createdAt.toISOString();
	return {
		id: () => row.id,
		blobId: () => messageBlobId(row.id),
		threadId: () => threadIdFor(row),
		mailboxIds: () => mailboxIdsFor(row),
		keywords: () => keywordsFor(row),
		size: () => (options.bodiesLoaded === false ? row.bodySize ?? 0 : body().textSize + body().htmlSize) + attachments.reduce((total, item) => total + item.size, 0),
		receivedAt: sentAt,
		messageId: () => (stripBrackets(row.providerMessageId) ? [stripBrackets(row.providerMessageId)!] : null),
		inReplyTo: () => (row.inReplyTo ? [row.inReplyTo] : null),
		references: () => (row.references ? row.references.split(/\s+/).filter(Boolean) : null),
		sender: from,
		from,
		to: () => toAddressObjects(row.toAddr),
		cc: () => toAddressObjects(row.ccAddr),
		bcc: () => toAddressObjects(row.bccAddr),
		replyTo: () => null,
		subject: () => row.subject,
		sentAt,
		hasAttachment: () => attached.length > 0,
		preview: () => (row.snippet ?? htmlToReadableText(row.htmlBody ?? "") ?? row.textBody ?? "").replace(/\s+/g, " ").trim().slice(0, 256),
		bodyStructure: () => body().structure,
		bodyValues: () => (options.fetchBodies ? body().bodyValues : {}),
		textBody: () => {
			const { textPart, htmlPart } = body();
			return textPart ? [textPart] : htmlPart ? [htmlPart] : [];
		},
		htmlBody: () => {
			const { textPart, htmlPart } = body();
			return htmlPart ? [htmlPart] : textPart ? [textPart] : [];
		},
		attachments: () => [...inline, ...attached].map(attachmentPart),
	};
}

type EmailReaders = ReturnType<typeof emailReaders>;
export type EmailObject = { [K in keyof EmailReaders]: ReturnType<EmailReaders[K]> };

/** The whole Email object (RFC 8621 §4.1) from a stored row and its attachments. */
export function buildEmailObject(row: MessageRow, attachments: AttachmentRow[], options: EmailObjectOptions): EmailObject {
	const readers = emailReaders(row, attachments, options);
	return Object.fromEntries(Object.entries(readers).map(([key, read]) => [key, read()])) as EmailObject;
}

/**
 * The Email object restricted to `properties` (always with `id`), or the whole
 * object when `properties` is null. `header:` properties come from stored
 * fields; unknown property names are left out.
 */
export function pickEmailProperties(row: MessageRow, attachments: AttachmentRow[], properties: readonly string[] | null | undefined, options: EmailObjectOptions): Record<string, unknown> {
	if (!properties) return buildEmailObject(row, attachments, options);
	const readers = emailReaders(row, attachments, options);
	const picked: Record<string, unknown> = { id: row.id };
	for (const key of properties) {
		if (key.startsWith("header:")) picked[key] = resolveHeaderProperty(row, key);
		else if (Object.hasOwn(readers, key)) picked[key] = readers[key as keyof EmailReaders]();
	}
	return picked;
}

/** Attachment rows for many messages, keyed by message id, in IN lists D1 can bind. */
export async function loadAttachmentsByMessage(ctx: JmapContext, messageIds: string[]): Promise<Map<string, AttachmentRow[]>> {
	const result = new Map<string, AttachmentRow[]>();
	if (messageIds.length === 0) return result;
	const chunks = await Promise.all(chunkForParameters(messageIds, 0).map((ids) => ctx.db.select().from(messageAttachments).where(inArray(messageAttachments.messageId, ids))));
	for (const row of chunks.flat()) {
		const list = result.get(row.messageId) ?? [];
		list.push(row);
		result.set(row.messageId, list);
	}
	return result;
}

/** `header:Name[:asForm]` properties, answered from stored fields; unknown headers are null. */
export function resolveHeaderProperty(row: MessageRow, property: string): unknown {
	const [, name, form] = property.split(":");
	const lower = (name ?? "").toLowerCase();
	const raw = (() => {
		switch (lower) {
			case "subject":
				return row.subject;
			case "from":
				return row.fromAddr;
			case "to":
				return row.toAddr;
			case "cc":
				return row.ccAddr;
			case "bcc":
				return row.bccAddr;
			case "message-id":
				return row.providerMessageId;
			case "in-reply-to":
				return row.inReplyTo ? `<${row.inReplyTo}>` : null;
			case "references":
				return row.references ? row.references.split(/\s+/).map((id) => `<${id}>`).join(" ") : null;
			case "date":
				return row.createdAt.toUTCString();
			default:
				return null;
		}
	})();
	if (raw == null) return null;
	switch ((form ?? "asRaw").toLowerCase()) {
		case "asaddresses":
			return toAddressObjects(raw);
		case "asmessageids":
			return raw.split(/\s+/).map((id) => id.replace(/^<|>$/g, "")).filter(Boolean);
		case "asdate":
			return row.createdAt.toISOString();
		case "astext":
			return raw;
		default:
			return ` ${raw}`;
	}
}
