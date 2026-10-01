import { getEmailAddressList, splitEmailAddressList } from "@/lib/email/address";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { escapeHtml } from "../html";

export type ReplyMode = "reply" | "all" | "forward";

type ReplySource = {
	direction: "inbound" | "outbound";
	fromAddr: string;
	toAddr: string;
	ccAddr: string | null;
};

/**
 * Who a reply goes to. A reply answers the sender; reply-all keeps everyone on
 * To and Cc except the mailbox's own addresses. Replying to your own message
 * re-addresses its recipients. Forwards start empty.
 */
export function buildReplyRecipients(
	message: ReplySource,
	mode: ReplyMode,
	ownAddresses: string[],
): { to: string[]; cc: string[] } {
	if (mode === "forward") return { to: [], cc: [] };
	const own = new Set(ownAddresses.map((address) => address.toLowerCase()));
	const seen = new Set<string>();
	const keep = (entries: string[]) =>
		entries.filter((entry) => {
			const [address] = getEmailAddressList(entry);
			if (!address || own.has(address) || seen.has(address)) return false;
			seen.add(address);
			return true;
		});
	if (message.direction === "outbound") {
		const to = keep(splitEmailAddressList(message.toAddr));
		return { to, cc: mode === "all" ? keep(splitEmailAddressList(message.ccAddr)) : [] };
	}
	const to = keep([message.fromAddr]);
	if (mode !== "all") return { to, cc: [] };
	return { to, cc: keep([...splitEmailAddressList(message.toAddr), ...splitEmailAddressList(message.ccAddr)]) };
}

export function replySubject(subject: string | null | undefined, mode: ReplyMode): string {
	const value = (subject ?? "").trim();
	if (mode === "forward") return /^fwd?:/i.test(value) ? value : `Fwd: ${value}`.trim();
	return /^re:/i.test(value) ? value : `Re: ${value}`.trim();
}

/** Plain text as HTML: escaped, line breaks kept. */
export function textToHtml(text: string): string {
	return escapeHtml(text.replace(/\r\n?/g, "\n")).replace(/\n/g, "<br>");
}

/**
 * The quoted original under a reply or forward, as escaped text. Drafts are
 * opened by both interfaces' editors, so the sender's HTML never goes into one.
 */
export function buildQuoteHtml(
	message: ReplySource & { subject: string | null; createdAt: Date; textBody: string | null; htmlBody: string | null },
	mode: ReplyMode,
	formatDate: (date: Date) => string,
): string {
	const text = (message.textBody?.trim() || htmlToMailText(message.htmlBody)).trim();
	const body = textToHtml(text);
	if (mode === "forward") {
		const lines = [
			"---------- Forwarded message ---------",
			`From: ${message.fromAddr}`,
			`Date: ${formatDate(message.createdAt)}`,
			`Subject: ${message.subject ?? "(no subject)"}`,
			`To: ${message.toAddr}`,
			...(message.ccAddr ? [`Cc: ${message.ccAddr}`] : []),
		];
		return `<div>${lines.map(escapeHtml).join("<br>")}</div><br><div>${body}</div>`;
	}
	return `<div>On ${escapeHtml(formatDate(message.createdAt))}, ${escapeHtml(message.fromAddr)} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote>`;
}

/** The text/plain part of an HTML body: one line per block, quotes prefixed with "> ". */
export function htmlToMailText(html: string | null | undefined): string {
	if (!html) return "";
	const marked = html
		.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, inner: string) =>
			htmlToReadableText(inner)
				.split("\n")
				.map((line) => `> ${line.trim()}`)
				.join("\n"))
		.replace(/<li\b[^>]*>/gi, "\n- ");
	return htmlToReadableText(marked)
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** "mailboxId|address" from the composer's From menu. */
export function parseFromValue(value: string | null | undefined): { mailboxId: string; address: string } | null {
	const [mailboxId, address] = (value ?? "").split("|");
	if (!mailboxId || !address || !/^[A-Za-z0-9_-]{1,64}$/.test(mailboxId)) return null;
	return { mailboxId, address: address.trim().toLowerCase() };
}

/** A comma-separated recipient field, normalised the way the send path expects. */
export function normalizeRecipients(value: string | null | undefined): string {
	return splitEmailAddressList(value).map((entry) => entry.trim()).filter(Boolean).join(", ");
}
