import type { JmapContext } from "./types";

/**
 * Run `compute` at most once per request under `key` and hand every later
 * caller the same promise. The context lives for one JMAP request (or one
 * event-source tick), so this is where values every handler needs, such as
 * the state strings, are shared instead of re-read. A rejected computation
 * is dropped so a transient database error does not poison the request.
 */
export function memoize<T>(ctx: JmapContext, key: string, compute: () => Promise<T>): Promise<T> {
	const memo = (ctx.memo ??= new Map());
	const cached = memo.get(key) as Promise<T> | undefined;
	if (cached) return cached;
	const pending = compute();
	memo.set(key, pending);
	pending.catch(() => {
		if (memo.get(key) === pending) memo.delete(key);
	});
	return pending;
}

/** Drop everything memoized so far; call after a write so later reads see it. */
export function forgetMemo(ctx: JmapContext): void {
	ctx.memo?.clear();
}
