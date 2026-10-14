import { base64UrlDecode, base64UrlEncode, pointToJwkCoordinates, utf8 } from "./encoding-utils";
import type { PushConfig } from "./types";

/** RFC 8292 §2: `exp` must be no more than 24 hours ahead. */
export const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

/**
 * A short, stable name for a VAPID public key, stored on each subscription so
 * rows made under an older key can be recognised after the key changes.
 */
export async function vapidKeyId(publicKey: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(publicKey.trim())));
	return base64UrlEncode(digest).slice(0, 16);
}

/** The JWT audience is the push service's origin, not the full endpoint URL. */
export function vapidAudience(endpoint: string): string {
	return new URL(endpoint).origin;
}

export function isValidVapidSubject(subject: string): boolean {
	return /^mailto:[^\s@]+@[^\s@]+$/.test(subject) || /^https:\/\/\S+$/.test(subject);
}

/**
 * Imports VAPID_PRIVATE_KEY (the 32-byte scalar `d`, base64url, as web-push and
 * most generators print it) for ES256 signing. Web Crypto has no raw private
 * key import, so it goes through a JWK with the coordinates from the public key.
 */
export async function importVapidSigningKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
	const point = base64UrlDecode(publicKey);
	const coordinates = point ? pointToJwkCoordinates(point) : null;
	const scalar = base64UrlDecode(privateKey);
	if (!coordinates) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 public key in base64url");
	if (!scalar || scalar.length !== 32) throw new Error("VAPID_PRIVATE_KEY must be a 32-byte P-256 private key in base64url");
	return crypto.subtle.importKey(
		"jwk",
		{ kty: "EC", crv: "P-256", ...coordinates, d: base64UrlEncode(scalar), ext: true },
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
}

export async function importVapidVerifyKey(publicKey: string): Promise<CryptoKey> {
	const point = base64UrlDecode(publicKey);
	if (!point || !pointToJwkCoordinates(point)) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 public key in base64url");
	return crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

/**
 * An ES256 JWT for one push service (RFC 8292 §2). Web Crypto's ECDSA
 * signature is already the raw r || s pair JWS expects.
 */
export async function createVapidJwt(config: PushConfig, audience: string, now = Date.now()): Promise<string> {
	const header = base64UrlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = base64UrlEncode(utf8(JSON.stringify({
		aud: audience,
		exp: Math.floor(now / 1000) + VAPID_TOKEN_LIFETIME_SECONDS,
		sub: config.subject,
	})));
	const signingInput = `${header}.${claims}`;
	const key = await importVapidSigningKey(config.publicKey, config.privateKey);
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput));
	return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** The `Authorization` header value for a push to `endpoint` (RFC 8292 §3). */
export async function vapidAuthorization(config: PushConfig, endpoint: string, now = Date.now()): Promise<string> {
	const token = await createVapidJwt(config, vapidAudience(endpoint), now);
	return `vapid t=${token}, k=${config.publicKey}`;
}

/** Checks a VAPID JWT's signature and returns its claims, or null. */
export async function verifyVapidJwt(token: string, publicKey: string): Promise<Record<string, unknown> | null> {
	const [header, claims, signature] = token.split(".");
	const signatureBytes = signature ? base64UrlDecode(signature) : null;
	const claimBytes = claims ? base64UrlDecode(claims) : null;
	if (!header || !claimBytes || !signatureBytes) return null;
	const key = await importVapidVerifyKey(publicKey);
	const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signatureBytes, utf8(`${header}.${claims}`));
	return valid ? JSON.parse(new TextDecoder().decode(claimBytes)) as Record<string, unknown> : null;
}
