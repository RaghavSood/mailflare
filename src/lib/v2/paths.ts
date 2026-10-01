import type { V2Route, V2View, V2ViewKey } from "./types";

export const V2_BASE = "/v2";

/** The mail views, in navigation order. `classic` is the equivalent old route. */
export const V2_VIEWS: V2View[] = [
	{ key: "inbox", label: "Inbox", icon: "inbox", go: "g i", classic: "/inbox" },
	{ key: "starred", label: "Starred", icon: "star", go: "g s", classic: "/starred" },
	{ key: "snoozed", label: "Snoozed", icon: "clock", go: "g b", classic: "/snoozed" },
	{ key: "sent", label: "Sent", icon: "send", go: "g t", classic: "/sent" },
	{ key: "drafts", label: "Drafts", icon: "file", go: "g d", classic: "/drafts" },
	{ key: "archive", label: "Archive", icon: "archive", go: null, classic: "/archived" },
	{ key: "all", label: "All mail", icon: "mail", go: "g a", classic: "/inbox" },
	{ key: "spam", label: "Spam", icon: "alert", go: null, classic: "/spam" },
	{ key: "trash", label: "Trash", icon: "trash", go: null, classic: "/trash" },
];

const VIEW_KEYS = new Set<V2ViewKey>([...V2_VIEWS.map((view) => view.key), "folder", "search"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function getView(key: V2ViewKey): V2View | undefined {
	return V2_VIEWS.find((view) => view.key === key);
}

function query(params: Record<string, string | number | null | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === null || value === undefined || value === "" || value === 0) continue;
		search.set(key, String(value));
	}
	const value = search.toString();
	return value ? `?${value}` : "";
}

function viewPath(view: V2ViewKey, folderId?: string | null): string {
	return view === "folder" && folderId ? `${V2_BASE}/folder/${folderId}` : `${V2_BASE}/${view}`;
}

export function listHref(
	view: V2ViewKey,
	options: { folderId?: string | null; q?: string | null; page?: number } = {},
): string {
	return `${viewPath(view, options.folderId)}${query({ q: options.q, page: options.page && options.page > 1 ? options.page : null })}`;
}

/** A conversation opened from a list; `i` is its position there, for older/newer. */
export function threadHref(
	view: V2ViewKey,
	messageId: string,
	options: { folderId?: string | null; q?: string | null; i?: number | null } = {},
): string {
	return `${viewPath(view, options.folderId)}/${messageId}${query({ q: options.q, i: options.i ?? null })}`;
}

/** Splits /v2/... into a route. Unknown paths are `notFound`; ids are validated. */
export function parseV2Path(pathname: string): V2Route {
	const segments = pathname.replace(/\/+$/, "").split("/").filter(Boolean).slice(1);
	if (segments.length === 0) return { kind: "home" };
	const [first, second, third] = segments;
	if (first === "folder") {
		if (!second || !ID_PATTERN.test(second) || segments.length > 3) return { kind: "notFound" };
		if (third && !ID_PATTERN.test(third)) return { kind: "notFound" };
		return { kind: "view", view: "folder", folderId: second, messageId: third ?? null };
	}
	if (VIEW_KEYS.has(first as V2ViewKey)) {
		if (segments.length > 2 || (second && !ID_PATTERN.test(second))) return { kind: "notFound" };
		return { kind: "view", view: first as V2ViewKey, folderId: null, messageId: second ?? null };
	}
	return { kind: "action", name: segments.join("/") };
}

/** The classic route for a v2 path, so the toggle lands on the same place. */
export function v2ToClassic(pathname: string): string {
	const route = parseV2Path(pathname);
	if (route.kind !== "view") return "/inbox";
	const base = route.view === "folder" && route.folderId
		? `/folders/${route.folderId}`
		: getView(route.view)?.classic ?? "/inbox";
	const keepsMessage = route.messageId && route.view !== "all" && route.view !== "search";
	return keepsMessage ? `${base}/${route.messageId}` : base;
}

/** The v2 path for a classic route (settings and other pages land on the inbox). */
export function classicToV2(pathname: string): string {
	const segments = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
	if (segments[0] === "folders" && segments[1] && ID_PATTERN.test(segments[1])) {
		const messageId = segments[2] && ID_PATTERN.test(segments[2]) ? segments[2] : null;
		return messageId ? `${V2_BASE}/folder/${segments[1]}/${messageId}` : `${V2_BASE}/folder/${segments[1]}`;
	}
	const view = V2_VIEWS.find((item) => item.classic === `/${segments[0]}` && item.key !== "all");
	if (!view) return `${V2_BASE}/inbox`;
	const messageId = segments[1] && ID_PATTERN.test(segments[1]) ? segments[1] : null;
	return messageId ? `${V2_BASE}/${view.key}/${messageId}` : `${V2_BASE}/${view.key}`;
}

/** Only same-site v2 paths are accepted as a post-action destination. */
export function safeReturnPath(value: string | null | undefined, fallback = `${V2_BASE}/inbox`): string {
	if (!value || !value.startsWith(`${V2_BASE}/`) || value.startsWith("//") || /[\r\n\\]/.test(value)) return fallback;
	return value;
}
