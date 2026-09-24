import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { getEmailAddress } from "@/lib/email/address";
import { buildMessageHeaderDetails, getHeaderBlock, parseHeaderList } from "@/lib/email/header-utils";
import type { MessageHeaderDetails } from "@/lib/email/header-types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

const HEADER_RANGE_BYTES = 256 * 1024;

async function getReadableMessage(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [message] = await db
		.select({
			mailboxId: messages.mailboxId,
			rawR2Key: messages.rawR2Key,
			deliveredTo: messages.deliveredTo,
			envelopeFrom: messages.envelopeFrom,
		})
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	return access?.canRead ? message : null;
}

/**
 * Header details for the reader's "show details" panel. Messages without a stored
 * original (sent mail, or mail imported before originals were kept) still report
 * the envelope recorded on the row.
 */
export async function getMessageHeaderDetailsForUser(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
): Promise<{ details: MessageHeaderDetails; hasOriginal: boolean } | null> {
	const message = await getReadableMessage(env, user, messageId);
	if (!message) return null;
	const envelope = { deliveredTo: message.deliveredTo, envelopeFrom: message.envelopeFrom };
	const object = message.rawR2Key
		? await env.BUCKET.get(message.rawR2Key, { range: { offset: 0, length: HEADER_RANGE_BYTES } })
		: null;
	if (!object) return { details: buildMessageHeaderDetails([], envelope), hasOriginal: false };
	const headers = parseHeaderList(getHeaderBlock(await object.arrayBuffer()));
	// Mail received before the envelope was stored on the row still has it on the R2 object.
	const stored = {
		deliveredTo: envelope.deliveredTo ?? (getEmailAddress(object.customMetadata?.to ?? "") || null),
		envelopeFrom: envelope.envelopeFrom ?? (getEmailAddress(object.customMetadata?.from ?? "") || null),
	};
	return { details: buildMessageHeaderDetails(headers, stored), hasOriginal: true };
}

/** The stored original MIME, for "Show original". */
export async function getMessageOriginalForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const message = await getReadableMessage(env, user, messageId);
	if (!message?.rawR2Key) return null;
	const object = await env.BUCKET.get(message.rawR2Key);
	return object ? { object } : null;
}
