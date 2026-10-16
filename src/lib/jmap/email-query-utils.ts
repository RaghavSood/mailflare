import { buildFtsMatch } from "@/lib/search/query-utils";
import { LIMITS } from "./constants";

/**
 * How far into a result list Email/query reaches. The materialising path
 * reads at most this many rows, so a page at or past it is empty and `total`
 * never exceeds it; the SQL-paged path keeps the same bound so both paths,
 * and Email/queryChanges, describe the same list.
 */
export const QUERY_WINDOW = 10_000;

/** D1 rejects a LIKE or GLOB pattern longer than this many bytes ("pattern too complex"). */
export const MAX_LIKE_PATTERN_BYTES = 50;

/** `limit` as Email/query has always read it: absent means the maximum, and it is clamped to [0, max]. */
export function queryLimit(value: unknown): number {
	return Math.min(Math.max(Number(value ?? LIMITS.maxQueryLimit), 0), LIMITS.maxQueryLimit);
}

/**
 * The page a query can fetch with LIMIT/OFFSET, or null when it needs the
 * whole ordered list in memory: an anchor has to be found in it, a negative
 * position counts from its end, and collapseThreads keeps the first message
 * of each thread in sort order. Anything that is not a plain non-negative
 * integer also goes the materialising way, so odd inputs answer as they
 * always have.
 */
export function planEmailQueryPage(args: Record<string, unknown>): { position: number; limit: number } | null {
	if (args.anchor || args.collapseThreads) return null;
	const position = Number(args.position ?? 0);
	const limit = queryLimit(args.limit);
	if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(limit)) return null;
	return { position, limit };
}

/** LIMIT and OFFSET for a page, cut at QUERY_WINDOW; null when the page lies wholly past it. */
export function windowedPage(page: { position: number; limit: number }): { limit: number; offset: number } | null {
	const limit = Math.min(page.limit, QUERY_WINDOW - page.position);
	return limit > 0 ? { limit, offset: page.position } : null;
}

/**
 * The FTS5 MATCH expression for a JMAP `text` filter, built by the same code
 * as the web search box: every word must appear somewhere in the message
 * (subject, from, to, cc or body), plain words match by prefix, quoted text
 * as a phrase, and the client's string is always quoted so it can never
 * change the MATCH grammar. RFC 8621 gives `text` no exclusion syntax, so a
 * leading "-" is dropped rather than read as the search box's negation.
 * Null when the text has no letters or digits.
 */
export function jmapTextMatch(text: string): string | null {
	const literal = text.replace(/\s+/g, " ").replace(/(^| )-+/g, "$1").trim();
	return buildFtsMatch({ text: literal, needsFullText: true });
}

/** Whether `%text%` (escaped) fits D1's LIKE pattern limit. */
export function fitsLikePattern(escaped: string): boolean {
	return new TextEncoder().encode(escaped).length + 2 <= MAX_LIKE_PATTERN_BYTES;
}

type FilterShape = string[] | { operator: string; conditions: FilterShape[] };

function filterShape(filter: unknown): FilterShape | null {
	if (!filter || typeof filter !== "object") return null;
	const record = filter as Record<string, unknown>;
	if (typeof record.operator === "string") {
		const conditions = Array.isArray(record.conditions) ? record.conditions : [];
		return { operator: record.operator, conditions: conditions.map(filterShape).filter((shape): shape is FilterShape => !!shape) };
	}
	return Object.keys(record).sort();
}

/**
 * What an Email/query asked for, without any of its values: filter keys
 * (search text and addresses are the user's data), sort, and paging. Logged
 * at debug level so a client's real request shape can be read off the logs.
 */
export function describeEmailQueryShape(args: Record<string, unknown>, fastPath: boolean) {
	const sort = Array.isArray(args.sort)
		? args.sort.map((item: Record<string, unknown>) => `${String(item?.property)}${item?.keyword ? `:${String(item.keyword)}` : ""} ${item?.isAscending ? "asc" : "desc"}`)
		: null;
	return {
		filter: filterShape(args.filter),
		sort,
		collapseThreads: args.collapseThreads ?? null,
		anchor: args.anchor ? true : null,
		anchorOffset: args.anchorOffset ?? null,
		position: args.position ?? null,
		limit: args.limit ?? null,
		calculateTotal: args.calculateTotal ?? null,
		fastPath,
	};
}
