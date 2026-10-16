import bcrypt from "bcryptjs";
import { newId } from "@/lib/ids";
import { apiKeyPrefix, digestApiKey } from "@/lib/api/key-auth-utils";

const KEY_PREFIX = "ep_";

/**
 * A new key with both verifiers: the SHA-256 digest that authentication looks
 * up, and a bcrypt hash that only an older build (one predating the digest
 * column) would read. The bcrypt cost is paid once, here, not per request.
 */
export async function generateApiKey(): Promise<{ fullKey: string; prefix: string; hash: string; digest: string }> {
	const secret = newId();
	const fullKey = `${KEY_PREFIX}${secret}`;
	const prefix = apiKeyPrefix(fullKey);
	const hash = bcrypt.hashSync(fullKey, 10);
	return { fullKey, prefix, hash, digest: await digestApiKey(fullKey) };
}

/** bcrypt check for keys minted before the digest column; see `authenticateApiKeyValue`. */
export function verifyApiKey(fullKey: string, hash: string): boolean {
	return bcrypt.compareSync(fullKey, hash);
}

export function parseScopes(scopesJson: string): string[] {
	try {
		const parsed = JSON.parse(scopesJson) as unknown;
		return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
	} catch {
		return [];
	}
}

export function scopesToJson(scopes: string[]): string {
	return JSON.stringify(scopes);
}
