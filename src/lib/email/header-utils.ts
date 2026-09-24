import type { AuthenticationCheck, MessageHeaderDetails, RawHeader } from "./header-types";

const MAX_HEADER_BYTES = 256 * 1024;

/** The header section of a raw RFC 5322 message, up to the first blank line. */
export function getHeaderBlock(raw: ArrayBuffer): string {
	const slice = raw.slice(0, Math.min(raw.byteLength, MAX_HEADER_BYTES));
	const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
	const headerEnd = text.search(/\r?\n\r?\n/);
	return headerEnd === -1 ? text : text.slice(0, headerEnd);
}

/** Every header in order, with folded continuation lines joined by a single space. */
export function parseHeaderList(headerBlock: string): RawHeader[] {
	const headers: RawHeader[] = [];
	for (const line of headerBlock.split(/\r?\n/)) {
		if (/^[\t ]/.test(line)) {
			const last = headers[headers.length - 1];
			if (last) last.value = `${last.value} ${line.trim()}`.trim();
			continue;
		}
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		headers.push({ name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() });
	}
	return headers;
}

export function getHeaderValues(headers: RawHeader[], name: string): string[] {
	const wanted = name.toLowerCase();
	return headers.filter((header) => header.name.toLowerCase() === wanted).map((header) => header.value);
}

function getFirstHeader(headers: RawHeader[], name: string): string | null {
	return getHeaderValues(headers, name).find((value) => value.trim()) ?? null;
}

function extractAddress(value: string | null): string | null {
	if (!value) return null;
	const bracketed = value.match(/<([^<>\s]*)>/);
	const candidate = (bracketed ? bracketed[1] : value).trim().replace(/^"|"$/g, "");
	return candidate.includes("@") ? candidate.toLowerCase() : null;
}

function getDomain(address: string | null): string | null {
	if (!address) return null;
	const at = address.lastIndexOf("@");
	const domain = (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase();
	return domain || null;
}

/**
 * The address the message was delivered to, as the receiving server recorded it.
 * Postfix writes X-Original-To before alias expansion and Delivered-To after it;
 * Fastmail writes X-Delivered-To. The topmost occurrence is the final hop.
 */
export function getEnvelopeRecipient(headers: RawHeader[]): string | null {
	for (const name of ["x-original-to", "x-delivered-to", "envelope-to", "delivered-to"]) {
		const address = extractAddress(getFirstHeader(headers, name));
		if (address) return address;
	}
	return null;
}

export function getEnvelopeSender(headers: RawHeader[]): string | null {
	return extractAddress(getFirstHeader(headers, "return-path"))
		?? extractAddress(getFirstHeader(headers, "x-mail-from"));
}

/** Removes RFC 5322 comments, e.g. "(body has been altered)", including nested ones. */
function stripComments(value: string): string {
	let result = "";
	let depth = 0;
	let quoted = false;
	for (const char of value) {
		if (char === '"' && depth === 0) quoted = !quoted;
		if (!quoted && char === "(") {
			depth += 1;
			continue;
		}
		if (!quoted && char === ")" && depth > 0) {
			depth -= 1;
			continue;
		}
		if (depth === 0) result += char;
	}
	return result;
}

function getAuthservId(value: string): string {
	return stripComments(value).split(";")[0].trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function getCheckDomain(method: string, properties: Map<string, string>): string | null {
	if (method === "dkim") {
		return properties.get("header.d") ?? getDomain(properties.get("header.i") ?? null);
	}
	if (method === "spf") {
		return getDomain(properties.get("smtp.mailfrom") ?? null) ?? properties.get("smtp.helo") ?? null;
	}
	if (method === "dmarc") return properties.get("header.from") ?? properties.get("d") ?? null;
	return null;
}

/**
 * Results from the topmost Authentication-Results header's server (RFC 8601).
 * Headers further down were added by earlier hops and can be forged by the
 * sender, so only the receiving server's own verdicts are returned.
 */
export function parseAuthenticationResults(headers: RawHeader[]): { authservId: string | null; checks: AuthenticationCheck[] } {
	const values = getHeaderValues(headers, "authentication-results");
	if (values.length === 0) return { authservId: null, checks: [] };
	const authservId = getAuthservId(values[0]);
	const checks: AuthenticationCheck[] = [];
	for (const value of values) {
		if (getAuthservId(value) !== authservId) continue;
		const [, ...segments] = stripComments(value).split(";");
		for (const segment of segments) {
			const match = segment.trim().match(/^([a-z0-9-]+)\s*=\s*([a-z]+)\b(.*)$/is);
			if (!match) continue;
			const method = match[1].toLowerCase();
			const properties = new Map<string, string>();
			for (const property of match[3].matchAll(/([a-z0-9._-]+)\s*=\s*("[^"]*"|[^\s;]+)/gi)) {
				properties.set(property[1].toLowerCase(), property[2].replace(/^"|"$/g, "").toLowerCase());
			}
			checks.push({ method, result: match[2].toLowerCase(), domain: getCheckDomain(method, properties) });
		}
	}
	return { authservId, checks };
}

function isPrivateHost(value: string): boolean {
	return /\b(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/i.test(value)
		|| /\.internal\b/i.test(value);
}

/**
 * How the message reached the first server that accepted it from the internet:
 * the topmost Received header whose "from" part is a public host. Null when that
 * hop did not record its transport, which is not the same as "unencrypted".
 */
export function getTransportSecurity(headers: RawHeader[]): string | null {
	for (const received of getHeaderValues(headers, "received")) {
		const fromPart = received.match(/^from\s+(.*?)\s+by\s/is)?.[1];
		if (!fromPart || isPrivateHost(fromPart)) continue;
		const version = received.match(/\b(TLS\s?v?1(?:\.\d)?|TLS1_\d)\b/i)?.[1];
		if (version) return version.replace(/^TLS1_(\d)$/i, "TLSv1.$1").replace(/^TLS\s?v?/i, "TLSv");
		if (/\bwith\s+E?SMTPS|\bwith\s+ESMTP\/TLS|\bTLS\b/i.test(received)) return "TLS";
		return null;
	}
	return null;
}

export function buildMessageHeaderDetails(
	headers: RawHeader[],
	envelope: { deliveredTo?: string | null; envelopeFrom?: string | null } = {},
): MessageHeaderDetails {
	const { authservId, checks } = parseAuthenticationResults(headers);
	const envelopeFrom = envelope.envelopeFrom?.toLowerCase() || getEnvelopeSender(headers);
	const signedBy = [...new Set(
		checks
			.filter((check) => check.method === "dkim" && check.result === "pass" && check.domain)
			.map((check) => check.domain as string),
	)];
	return {
		deliveredTo: envelope.deliveredTo?.toLowerCase() || getEnvelopeRecipient(headers),
		envelopeFrom,
		replyTo: getFirstHeader(headers, "reply-to"),
		date: getFirstHeader(headers, "date"),
		messageId: getFirstHeader(headers, "message-id"),
		listId: getFirstHeader(headers, "list-id"),
		authservId,
		authentication: checks,
		signedBy,
		mailedBy: getDomain(envelopeFrom),
		transportSecurity: getTransportSecurity(headers),
		headers,
	};
}
