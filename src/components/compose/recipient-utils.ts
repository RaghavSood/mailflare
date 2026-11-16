import { getEmailAddress, joinEmailAddressList, parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function isValidRecipient(entry: string): boolean {
	return EMAIL_RE.test(getEmailAddress(entry).trim());
}

/** Turn raw typed text into recipient entries, deduplicated by bare address. */
export function parseRecipientEntries(value: string, existing: string[] = []): string[] {
	const seen = new Set(existing.map((entry) => getEmailAddress(entry).toLowerCase()));
	const result: string[] = [];
	for (const entry of splitEmailAddressList(value)) {
		const key = getEmailAddress(entry).toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

export function recipientsToHeader(entries: string[]): string {
	return joinEmailAddressList(entries);
}

export function headerToRecipients(value: string | null | undefined): string[] {
	return parseRecipientEntries(value ?? "");
}

/** Short label for a chip: the display name if there is one, else the address. */
export function getRecipientLabel(entry: string): string {
	const parts = parseEmailAddressParts(entry);
	return parts.name && parts.name !== parts.address ? parts.name : parts.address;
}

/**
 * Split what has been typed into finished entries and the part still being typed. A comma or
 * semicolon finishes an entry, and so does whitespace after a complete address, so "bob@x.io "
 * becomes a chip while "Maya Chen" keeps typing towards "<maya@...>". Separators inside quotes
 * or angle brackets do not count. public/v2-assets/app.js has the same rule (splitRecipients).
 */
export function splitTypedRecipients(text: string): { done: string[]; rest: string } {
	const done: string[] = [];
	let current = "";
	let quoted = false;
	let angle = false;
	for (const char of text) {
		if (char === "\"") quoted = !quoted;
		else if (char === "<" && !quoted) angle = true;
		else if (char === ">" && !quoted) angle = false;
		const separator = char === "," || char === ";" || (/\s/.test(char) && isCompleteRecipient(current));
		if (separator && !quoted && !angle) {
			if (current.trim()) done.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	return { done, rest: current.replace(/^\s+/, "") };
}

function isCompleteRecipient(text: string): boolean {
	const value = text.trim();
	return /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(value) || /<[^\s@<>]+@[^\s@<>]+>$/.test(value);
}
