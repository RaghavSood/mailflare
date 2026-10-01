import { getEmailDisplayName, parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";

/** The browser reports its zone in a cookie; anything Intl rejects falls back to UTC. */
export function resolveTimeZone(value: string | null | undefined): string {
	if (!value) return "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return value;
	} catch {
		return "UTC";
	}
}

function parts(date: Date, timeZone: string) {
	const formatted = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const get = (type: string) => formatted.find((part) => part.type === type)?.value ?? "";
	return { year: get("year"), month: get("month"), day: get("day") };
}

/** List timestamps, Gmail-style: a time today, a month and day this year, a date before. */
export function formatListDate(date: Date, timeZone: string, now = new Date()): string {
	const a = parts(date, timeZone);
	const b = parts(now, timeZone);
	if (a.year === b.year && a.month === b.month && a.day === b.day) {
		return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
	}
	if (a.year === b.year) {
		return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(date);
	}
	return new Intl.DateTimeFormat("en-US", { timeZone, year: "2-digit", month: "numeric", day: "numeric" }).format(date);
}

/** "Mon, Aug 24, 2026, 11:09 AM" for message headers and quotes. */
export function formatFullDate(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

/** "3 days ago" style hint shown beside full dates in a conversation. */
export function formatRelative(date: Date, now = new Date()): string {
	const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
	if (seconds < 60) return "just now";
	const units: Array<[number, string]> = [[60, "minute"], [3600, "hour"], [86400, "day"], [604800, "week"], [2592000, "month"], [31536000, "year"]];
	let label = "";
	for (let index = units.length - 1; index >= 0; index -= 1) {
		const [size, unit] = units[index];
		if (seconds >= size) {
			const value = Math.floor(seconds / size);
			label = `${value} ${unit}${value === 1 ? "" : "s"} ago`;
			break;
		}
	}
	return label;
}

export function formatSize(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCount(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

/** The name to show for an address header entry: display name, else the local part. */
export function displayName(entry: string, contactName?: string | null): string {
	if (contactName) return contactName;
	return getEmailDisplayName(entry);
}

export function bareAddress(entry: string): string {
	return parseEmailAddressParts(entry).address;
}

/** One or two letters for an avatar. */
export function initials(name: string): string {
	const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
	return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** A stable hue per address, so a sender keeps their avatar colour. */
export function avatarHue(address: string): number {
	let hash = 0;
	for (const char of address.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return hash % 360;
}

/** "me, Alice, Bob" for To/Cc lines, using "me" for the viewer's own addresses. */
export function recipientSummary(value: string | null | undefined, own: Set<string>): string {
	return splitEmailAddressList(value)
		.map((entry) => (own.has(bareAddress(entry).toLowerCase()) ? "me" : getEmailDisplayName(entry)))
		.join(", ");
}
