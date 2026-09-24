import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { storeMessageAttachments } from "@/lib/email/attachments";
import { getEnvelopeRecipient, getEnvelopeSender, getHeaderBlock, parseHeaderList } from "@/lib/email/header-utils";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { resolveThreadId } from "@/lib/email/threading";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { newId } from "@/lib/ids";
import { getImportMessagePlacement } from "./destination";
import type { ImportDestination } from "./destination-types";
import type { ImportMailboxResult, ImportMessageInput } from "./types";

export async function importMessagesToMailbox(
	env: CloudflareEnv,
	input: {
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		messages: ImportMessageInput[];
	},
): Promise<ImportMailboxResult> {
	const result: ImportMailboxResult = { imported: 0, skipped: 0, errors: [] };
	for (const message of input.messages) {
		try {
			const imported = await importMessageToMailbox(env, {
				userId: input.userId,
				mailboxId: input.mailboxId,
				destination: input.destination,
				filename: message.filename,
				raw: message.raw,
			});
			if (imported) {
				result.imported += 1;
			} else {
				result.skipped += 1;
			}
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${message.filename}: ${error instanceof Error ? error.message : "Import failed"}`);
		}
	}
	return result;
}

async function importMessageToMailbox(
	env: CloudflareEnv,
	input: {
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		filename: string;
		raw: ArrayBuffer;
	},
): Promise<boolean> {
	const parsed = await parseRawMime(input.raw);
	const db = getDb(env);
	const providerMessageId = parsed.messageId ?? `import:${input.filename}:${input.raw.byteLength}`;

	const headers = parseHeaderList(getHeaderBlock(input.raw));
	const deliveredTo = getEnvelopeRecipient(headers);
	const envelopeFrom = getEnvelopeSender(headers);

	const [existing] = await db
		.select({ id: messages.id, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(and(eq(messages.mailboxId, input.mailboxId), eq(messages.providerMessageId, providerMessageId)))
		.limit(1);
	if (existing) {
		// Messages imported before the original was kept get it on re-import, so
		// their headers and envelope recipient become visible.
		if (!existing.rawR2Key) {
			const rawR2Key = await storeImportedRaw(env, existing.id, input.raw);
			await db
				.update(messages)
				.set({ rawR2Key, deliveredTo, envelopeFrom })
				.where(and(eq(messages.id, existing.id), isNull(messages.rawR2Key)));
		}
		return false;
	}

	const messageId = newId("msg");
	const fromAddr = parsed.fromAddr ?? "unknown";
	const toAddr = parsed.toAddr ?? "";
	const createdAt = parsed.date ?? new Date();
	const placement = getImportMessagePlacement(input.destination);
	const threadId = await resolveThreadId(db, {
		mailboxId: input.mailboxId,
		messageId: parsed.messageId,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references,
	});
	const rawR2Key = await storeImportedRaw(env, messageId, input.raw);

	try {
		await db.insert(messages).values({
			id: messageId,
			userId: input.userId,
			mailboxId: input.mailboxId,
			folderId: placement.folderId,
			direction: placement.direction,
			providerMessageId,
			fromAddr,
			toAddr,
			ccAddr: parsed.ccAddr,
			subject: parsed.subject,
			snippet: buildSnippet(parsed.text, parsed.html),
			textBody: parsed.text,
			htmlBody: parsed.html,
			status: placement.status,
			read: placement.direction === "outbound",
			threadId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references.length ? parsed.references.join(" ") : null,
			rawR2Key,
			deliveredTo,
			envelopeFrom,
			createdAt,
		});
	} catch (error) {
		await env.BUCKET.delete(rawR2Key);
		throw error;
	}

	try {
		await storeMessageAttachments(env, messageId, parsed.attachments, { validate: false });
		const contactAddress = placement.direction === "outbound" ? toAddr : fromAddr;
		await upsertContactFromAddress(env, {
			userId: input.userId,
			address: contactAddress,
			source: placement.direction === "outbound" ? "outbound" : "inbound",
		});
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, messageId));
		await env.BUCKET.delete(rawR2Key);
		throw error;
	}

	return true;
}

async function storeImportedRaw(env: CloudflareEnv, messageId: string, raw: ArrayBuffer): Promise<string> {
	const key = `imports/${messageId}.eml`;
	await env.BUCKET.put(key, raw, { httpMetadata: { contentType: "message/rfc822" } });
	return key;
}
