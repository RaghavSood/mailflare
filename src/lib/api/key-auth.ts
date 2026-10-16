import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { apiKeys, users } from "@/db/schema";
import { parseScopes, verifyApiKey } from "@/lib/api-keys";
import { apiKeyFromAuthorization, apiKeyPrefix, apiKeyRowWrite, digestApiKey, LAST_USED_WRITE_INTERVAL_MS } from "@/lib/api/key-auth-utils";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";

type KeyRow = typeof apiKeys.$inferSelect;
type UserRow = typeof users.$inferSelect;

/**
 * Resolve an API key to its user and scopes. Framework-free so it can run in
 * `worker.ts` as well as route handlers.
 *
 * The key's SHA-256 digest finds its row and user in one indexed query. A row
 * minted before the digest column (migration 0039) has none, so a miss falls
 * back to the prefix lookup and a bcrypt compare, restricted to rows still
 * without a digest; a match writes the digest, and that key's later requests
 * take the indexed path. Deleting the row revokes the key on the next request:
 * nothing about a key is cached between requests.
 */
export async function authenticateApiKeyValue(env: CloudflareEnv, key: string): Promise<ApiAuthResult | null> {
	const trimmed = key.trim();
	if (!trimmed) return null;
	const db = getDb(env);
	const digest = await digestApiKey(trimmed);

	const [found] = await db
		.select({ key: apiKeys, user: users })
		.from(apiKeys)
		.innerJoin(users, eq(apiKeys.userId, users.id))
		.where(eq(apiKeys.keyDigest, digest))
		.limit(1);
	if (found) return found.user.disabled ? null : authenticated(db, found.key, found.user, digest);

	const legacy = await db
		.select({ key: apiKeys, user: users })
		.from(apiKeys)
		.innerJoin(users, eq(apiKeys.userId, users.id))
		.where(and(eq(apiKeys.prefix, apiKeyPrefix(trimmed)), isNull(apiKeys.keyDigest)));
	for (const candidate of legacy) {
		if (candidate.user.disabled || !verifyApiKey(trimmed, candidate.key.keyHash)) continue;
		return authenticated(db, candidate.key, candidate.user, digest);
	}
	return null;
}

/**
 * Write back what the matched row needs (see `apiKeyRowWrite`), skipping the
 * statement entirely when nothing does. The WHERE guards keep two requests
 * racing on the same key from both writing.
 */
async function authenticated(db: AppDatabase, key: KeyRow, user: UserRow, digest: string): Promise<ApiAuthResult> {
	const write = apiKeyRowWrite(key, digest, new Date());
	if (write) {
		const guard = write.keyDigest
			? isNull(apiKeys.keyDigest)
			: or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, new Date(Date.now() - LAST_USED_WRITE_INTERVAL_MS)));
		await db.update(apiKeys).set(write).where(and(eq(apiKeys.id, key.id), guard));
	}
	return { userId: user.id, email: user.email, scopes: parseScopes(key.scopes), user };
}

/**
 * JMAP clients send the key either as a Bearer token or as the password of
 * HTTP Basic auth (the username is ignored; the key identifies the account).
 */
export async function authenticateApiRequest(env: CloudflareEnv, request: Request): Promise<ApiAuthResult | null> {
	const key = apiKeyFromAuthorization(request.headers.get("Authorization"));
	return key === null ? null : authenticateApiKeyValue(env, key);
}

export function hasScope(scopes: string[], required: string): boolean {
	return scopes.includes(required) || scopes.includes("*");
}
