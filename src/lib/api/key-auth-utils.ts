import type { ApiKeyRowWrite } from "./key-auth-types";

/** `lastUsedAt` is refreshed at most this often per key, since protocol clients make many small calls. */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** Keys are looked up by this many leading characters on the bcrypt path (`ep_` plus nine of the secret). */
export const API_KEY_PREFIX_LENGTH = 12;

export function apiKeyPrefix(key: string): string {
	return key.slice(0, API_KEY_PREFIX_LENGTH);
}

/**
 * Hex SHA-256 of the full key: the stored verifier. Keys are `ep_` plus a
 * 21-character nanoid (about 126 random bits), so an unsalted fast hash is
 * enough; bcrypt's cost buys nothing against a secret nobody can guess.
 * Web Crypto, so the same code runs on Workers and Node.
 */
export async function digestApiKey(key: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

export function isLastUsedFresh(lastUsedAt: Date | null, now: Date): boolean {
	if (!lastUsedAt) return false;
	return now.getTime() - lastUsedAt.getTime() < LAST_USED_WRITE_INTERVAL_MS;
}

/**
 * What a successful authentication writes back to the key's row: the digest
 * when the row predates it (the lazy upgrade after a bcrypt match), and
 * `lastUsedAt` when it is stale. Null when there is nothing to write, which is
 * every request but one a minute on an upgraded key.
 */
export function apiKeyRowWrite(row: { keyDigest: string | null; lastUsedAt: Date | null }, digest: string, now: Date): ApiKeyRowWrite | null {
	const write: ApiKeyRowWrite = {};
	if (!row.keyDigest) write.keyDigest = digest;
	if (!isLastUsedFresh(row.lastUsedAt, now)) write.lastUsedAt = now;
	return write.keyDigest || write.lastUsedAt ? write : null;
}

/**
 * The key carried by an Authorization header: a Bearer token, or the password
 * of HTTP Basic auth (the username is ignored; the key identifies the account).
 * JMAP clients send either. Null when the header carries neither.
 */
export function apiKeyFromAuthorization(authorization: string | null): string | null {
	if (!authorization) return null;
	if (authorization.startsWith("Bearer ")) return authorization.slice(7);
	if (!authorization.startsWith("Basic ")) return null;
	let decoded = "";
	try {
		decoded = atob(authorization.slice(6).trim());
	} catch {
		return null;
	}
	const separator = decoded.indexOf(":");
	return separator >= 0 ? decoded.slice(separator + 1) : decoded;
}
