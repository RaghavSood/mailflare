import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { selectDraftWithBody } from "@/app/api/drafts/[id]/utils";
import type { SessionUser } from "@/lib/auth/types";
import { wrapQuotedHtml, splitQuotedHtml } from "@/components/compose/rich-text-utils";
import { copyMessageAttachments, deleteMessageAttachment, listMessageAttachments, loadMessageAttachmentContents } from "@/lib/email/attachments";
import type { AttachmentContent } from "@/lib/email/attachment-types";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { buildSnippet } from "@/lib/email/parse";
import { sendEmail } from "@/lib/email/send";
import { getAuthorizedSenderAddress, getReplyFromAddress } from "@/lib/email/sender";
import { formatEmailAddress, getEmailAddressList } from "@/lib/email/address";
import { newId } from "@/lib/ids";
import type { V2Mailbox } from "../types";
import { buildQuoteHtml, buildReplyRecipients, htmlToMailText, normalizeRecipients, replySubject, type ReplyMode } from "./compose-utils";
import { loadThread } from "./thread";

export type ComposeDraft = {
	id: string | null;
	mailboxId: string | null;
	from: string | null;
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	bodyHtml: string;
	/** Quoted or forwarded original kept out of the editor and sent beneath it. */
	quoteHtml: string | null;
	inReplyTo: string | null;
	references: string | null;
	threadId: string | null;
	attachments: Array<{ id: string; filename: string; size: number }>;
};

export type ComposeInput = {
	draftId: string | null;
	mailboxId: string;
	from: string;
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	bodyHtml: string;
	inReplyTo: string | null;
	references: string | null;
	threadId: string | null;
};

export function emptyDraft(mailbox: V2Mailbox | undefined): ComposeDraft {
	return {
		id: null,
		mailboxId: mailbox?.id ?? null,
		from: mailbox ? mailbox.address : null,
		to: "",
		cc: "",
		bcc: "",
		subject: "",
		bodyHtml: signatureHtml(mailbox),
		quoteHtml: null,
		inReplyTo: null,
		references: null,
		threadId: null,
		attachments: [],
	};
}

function signatureHtml(mailbox: V2Mailbox | undefined): string {
	const signature = mailbox?.signature?.trim();
	if (!signature) return "";
	const escaped = signature.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
	return `<div><br></div><div data-mailflare-signature="1">-- <br>${escaped}</div>`;
}

export async function loadDraft(env: CloudflareEnv, user: SessionUser, draftId: string): Promise<ComposeDraft | null> {
	const draft = await selectDraftWithBody(getDb(env), user.id, draftId);
	if (!draft) return null;
	const { body, quoted } = splitQuotedHtml(draft.htmlBody ?? (draft.textBody ? draft.textBody.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>") : ""));
	const attachments = (await listMessageAttachments(env, draftId)).filter((item) => item.disposition === "attachment");
	return {
		id: draft.id,
		mailboxId: draft.mailboxId,
		from: getEmailAddressList(draft.fromAddr)[0] ?? null,
		to: draft.toAddr ?? "",
		cc: draft.ccAddr ?? "",
		bcc: draft.bccAddr ?? "",
		subject: draft.subject ?? "",
		bodyHtml: body,
		quoteHtml: quoted,
		inReplyTo: draft.inReplyTo,
		references: draft.references,
		threadId: draft.threadId,
		attachments: attachments.map((item) => ({ id: item.id, filename: item.filename, size: item.size })),
	};
}

/**
 * Create or update a draft. An update keeps the stored quote; a draft that no
 * longer exists (sent or discarded in another tab) is not recreated.
 */
export async function saveDraft(env: CloudflareEnv, user: SessionUser, input: ComposeInput): Promise<string | null> {
	const db = getDb(env);
	const sender = await getAuthorizedSenderAddress(env, { userId: user.id, from: input.from, mailboxId: input.mailboxId });
	let quote: string | null = null;
	if (input.draftId) {
		const existing = await selectDraftWithBody(db, user.id, input.draftId);
		if (!existing) return null;
		quote = splitQuotedHtml(existing.htmlBody).quoted;
	}
	const html = quote ? `${input.bodyHtml}${wrapQuotedHtml(quote)}` : input.bodyHtml;
	const text = htmlToMailText(html);
	const values = {
		mailboxId: sender.mailboxId,
		fromAddr: sender.fromAddr,
		toAddr: normalizeRecipients(input.to),
		ccAddr: normalizeRecipients(input.cc) || null,
		bccAddr: normalizeRecipients(input.bcc) || null,
		subject: input.subject || null,
		snippet: buildSnippet(text || null, html || null),
		textBody: text || null,
		htmlBody: html || null,
	};
	if (input.draftId) {
		await db.update(messages).set(values).where(and(eq(messages.id, input.draftId), eq(messages.userId, user.id), eq(messages.status, "draft")));
		return input.draftId;
	}
	const id = newId("msg");
	await db.insert(messages).values({
		id,
		userId: user.id,
		direction: "outbound",
		status: "draft",
		read: true,
		inReplyTo: input.inReplyTo,
		references: input.references,
		threadId: input.threadId,
		...values,
	});
	return id;
}

export async function discardDraft(env: CloudflareEnv, user: SessionUser, draftId: string): Promise<void> {
	const db = getDb(env);
	const [draft] = await db
		.select({ id: messages.id, userId: messages.userId, status: messages.status, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(eq(messages.id, draftId))
		.limit(1);
	if (!draft || draft.userId !== user.id || draft.status !== "draft") return;
	await deleteMessageWithObjects(env, db, draft.id, draft.rawR2Key);
}

export async function removeDraftAttachment(env: CloudflareEnv, user: SessionUser, draftId: string, attachmentId: string): Promise<boolean> {
	const draft = await selectDraftWithBody(getDb(env), user.id, draftId);
	if (!draft) return false;
	return deleteMessageAttachment(env, draftId, attachmentId);
}

/**
 * A reply, reply-all or forward draft of `messageId`: addressed, threaded,
 * sent from the address the message reached, with the original quoted beneath
 * and, for a forward, its attachments copied.
 */
export async function createReplyDraft(
	env: CloudflareEnv,
	user: SessionUser,
	input: { messageId: string; mode: ReplyMode; mailboxes: V2Mailbox[]; scopeMailboxIds: string[]; formatDate: (date: Date) => string },
): Promise<string | null> {
	const thread = await loadThread(env, { messageId: input.messageId, view: "all", scopeMailboxIds: input.scopeMailboxIds });
	const message = thread?.messages.find((item) => item.id === input.messageId)
		?? (thread ? thread.messages[thread.messages.length - 1] : null);
	if (!message?.mailboxId) return null;
	const mailbox = input.mailboxes.find((item) => item.id === message.mailboxId);
	if (!mailbox?.canSend) return null;
	const db = getDb(env);
	const replyFrom = await getReplyFromAddress(db, message);
	const listed = [...getEmailAddressList(message.toAddr), ...getEmailAddressList(message.ccAddr)];
	const fromAddress = message.direction === "outbound"
		? getEmailAddressList(message.fromAddr)[0]
		: replyFrom ?? listed.find((address) => mailbox.senderAddresses.includes(address)) ?? mailbox.address;
	const own = [...mailbox.senderAddresses, fromAddress];
	const recipients = buildReplyRecipients(message, input.mode, own);
	const parentId = message.providerMessageId?.trim().replace(/^<|>$/g, "") || null;
	const chain = (message.references ?? "").split(/\s+/).map((id) => id.replace(/^<|>$/g, "")).filter(Boolean);
	if (parentId && !chain.includes(parentId)) chain.push(parentId);
	const quote = buildQuoteHtml(message, input.mode, input.formatDate);
	const body = signatureHtml(mailbox);
	const html = `${body}${wrapQuotedHtml(quote)}`;
	const id = newId("msg");
	await db.insert(messages).values({
		id,
		userId: user.id,
		mailboxId: mailbox.id,
		direction: "outbound",
		status: "draft",
		read: true,
		fromAddr: formatEmailAddress(fromAddress, mailbox.name),
		toAddr: recipients.to.join(", "),
		ccAddr: recipients.cc.length ? recipients.cc.join(", ") : null,
		subject: replySubject(message.subject ?? thread?.subject, input.mode),
		snippet: null,
		textBody: htmlToMailText(html) || null,
		htmlBody: html,
		inReplyTo: input.mode === "forward" ? null : parentId,
		references: chain.length ? chain.join(" ") : null,
		threadId: message.threadId ?? parentId,
	});
	if (input.mode === "forward") await copyMessageAttachments(env, message.id, id);
	return id;
}

/** Send what the composer holds, with the draft's quote and stored attachments. */
export async function sendCompose(
	env: CloudflareEnv,
	user: SessionUser,
	input: ComposeInput & { uploads: AttachmentContent[]; scheduledAt?: string | null },
): Promise<{ messageId: string; scheduled?: boolean }> {
	const db = getDb(env);
	let quote: string | null = null;
	let stored: AttachmentContent[] = [];
	let threading = { inReplyTo: input.inReplyTo, references: input.references, threadId: input.threadId };
	if (input.draftId) {
		const draft = await selectDraftWithBody(db, user.id, input.draftId);
		if (draft) {
			quote = splitQuotedHtml(draft.htmlBody).quoted;
			stored = await loadMessageAttachmentContents(env, draft.id);
			threading = { inReplyTo: draft.inReplyTo, references: draft.references, threadId: draft.threadId };
		}
	}
	const html = quote ? `${input.bodyHtml}${wrapQuotedHtml(quote)}` : input.bodyHtml;
	const result = await sendEmail(env, {
		userId: user.id,
		mailboxId: input.mailboxId,
		from: input.from,
		to: normalizeRecipients(input.to),
		cc: normalizeRecipients(input.cc) || undefined,
		bcc: normalizeRecipients(input.bcc) || undefined,
		subject: input.subject || "(no subject)",
		html,
		text: htmlToMailText(html),
		inReplyTo: threading.inReplyTo,
		references: threading.references,
		threadId: threading.threadId,
		attachments: [...stored, ...input.uploads],
		scheduledAt: input.scheduledAt ?? undefined,
	});
	if (input.draftId) await discardDraft(env, user, input.draftId);
	return result;
}
