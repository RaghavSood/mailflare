/**
 * Counts and times D1 calls for one request, for the Server-Timing header.
 * Wraps the binding so every query path (Drizzle, raw prepare, batch) is seen.
 */
export type QueryTimer = { calls: number; ms: number };

function timed<T>(timer: QueryTimer, work: () => Promise<T>): Promise<T> {
	const start = performance.now();
	timer.calls += 1;
	return work().finally(() => {
		timer.ms += performance.now() - start;
	});
}

function wrapStatement(statement: D1PreparedStatement, timer: QueryTimer): D1PreparedStatement {
	return new Proxy(statement, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			if (property === "bind") return (...args: unknown[]) => wrapStatement(value.apply(target, args), timer);
			if (property === "all" || property === "raw" || property === "first" || property === "run") {
				return (...args: unknown[]) => timed(timer, () => value.apply(target, args));
			}
			return value.bind(target);
		},
	});
}

/** A copy of `env` whose DB binding reports into `timer`. */
export function withQueryTimer(env: CloudflareEnv, timer: QueryTimer): CloudflareEnv {
	const db = env.DB;
	const wrapped = new Proxy(db, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			if (property === "prepare") return (query: string) => wrapStatement(value.call(target, query), timer);
			if (property === "batch") {
				return (statements: D1PreparedStatement[]) =>
					timed(timer, () => value.call(target, statements.map((statement) => (statement as unknown as { __target?: D1PreparedStatement }).__target ?? statement)));
			}
			return value.bind(target);
		},
	});
	return { ...env, DB: wrapped } as CloudflareEnv;
}
