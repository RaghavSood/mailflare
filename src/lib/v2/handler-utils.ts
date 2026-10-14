/**
 * How an answer to a POST moves the address bar, as htmx response headers.
 * `HX-Push-Url` wins over `HX-Replace-Url` in htmx, so only one is ever sent.
 *
 * - `push`: the view changed; add a history entry for it.
 * - `replace`: the page the request came from is gone (a sent draft), so the
 *   page shown takes its entry. Back then skips it instead of reaching
 *   "Not found". Already on that page, nothing changes.
 * - `none`: the page shown is the one the address already names.
 */
export function historyHeaders(mode: "push" | "replace" | "none", target: string, current: string | null): Record<string, string> {
	if (mode === "push") return { "HX-Push-Url": target };
	if (mode === "replace" && current !== target) return { "HX-Replace-Url": target };
	return { "HX-Push-Url": "false" };
}
