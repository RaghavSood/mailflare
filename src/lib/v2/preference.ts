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
