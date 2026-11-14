import { classicToV2 } from "./paths";

/** Cookie remembering which interface the user last switched to. */
export const UI_PREFERENCE_COOKIE = "mf_ui";

/** Where to land after signing in: the interface the user last chose. */
export function homePathFor(preference: string | null | undefined): string {
	return preference === "v2" ? "/v2/inbox" : "/inbox";
}

export function homePathForRequest(request: Request): string {
	const match = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)mf_ui=([^;]+)/);
	return homePathFor(match?.[1]);
}

/**
 * Where a classic mail link on a page both interfaces share (settings) leads:
 * back to v2 for someone who chose it. Compose opens the floating composer in place.
 */
export function mailHrefFor(preference: string | null | undefined, classicHref: string): string {
	if (preference !== "v2" || classicHref === "/compose") return classicHref;
	return classicToV2(classicHref);
}
