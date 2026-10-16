/** Bytes backed by a plain ArrayBuffer, which every Web Crypto call accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes base64url (padding and standard-alphabet input tolerated); null when malformed. */
export function base64UrlDecode(value: string): Bytes | null {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
	if (!/^[A-Za-z0-9+/]*$/.test(normalized) || normalized.length % 4 === 1) return null;
	const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

export function utf8(value: string): Bytes {
	return concatBytes(new TextEncoder().encode(value));
}

/** The JWK coordinates of an uncompressed P-256 point (0x04 || x || y). */
export function pointToJwkCoordinates(point: Uint8Array): { x: string; y: string } | null {
	if (point.length !== 65 || point[0] !== 0x04) return null;
	return { x: base64UrlEncode(point.subarray(1, 33)), y: base64UrlEncode(point.subarray(33, 65)) };
}
