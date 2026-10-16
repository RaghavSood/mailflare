import { base64UrlDecode, concatBytes, pointToJwkCoordinates, utf8, type Bytes } from "./encoding-utils";

/** One record holds the whole message; push services accept at most 4096 octets of body. */
export const PUSH_RECORD_SIZE = 4096;
const HEADER_SIZE = 16 + 4 + 1 + 65;
const TAG_SIZE = 16;
/** Largest plaintext that fits in a 4096-octet body: header, padding delimiter and tag removed. */
export const MAX_PUSH_PLAINTEXT = PUSH_RECORD_SIZE - HEADER_SIZE - 1 - TAG_SIZE;

export type SenderKeys = { privateKey: CryptoKey; publicKey: Bytes };

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
	const key = await crypto.subtle.importKey("raw", concatBytes(ikm), "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: concatBytes(salt), info: concatBytes(info) }, key, length * 8);
	return new Uint8Array(bits);
}

/**
 * RFC 8291 §3.3-3.4 and RFC 8188 §2.2: the IKM from the ECDH secret and the
 * subscription's auth secret, then the content encryption key and nonce.
 */
export async function derivePushKeys(input: {
	ecdhSecret: Uint8Array;
	authSecret: Uint8Array;
	userAgentPublicKey: Uint8Array;
	senderPublicKey: Uint8Array;
	salt: Uint8Array;
}): Promise<{ ikm: Bytes; cek: Bytes; nonce: Bytes }> {
	const keyInfo = concatBytes(utf8("WebPush: info\0"), input.userAgentPublicKey, input.senderPublicKey);
	const ikm = await hkdf(input.authSecret, input.ecdhSecret, keyInfo, 32);
	const cek = await hkdf(input.salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(input.salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
	return { ikm, cek, nonce };
}

/** A fresh ephemeral ECDH key pair, as each push message uses. */
export async function generateSenderKeys(): Promise<SenderKeys> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
	return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

/** Imports a fixed sender key pair (both base64url), for reproducing the RFC 8291 example. */
export async function importSenderKeys(publicKey: string, privateKey: string): Promise<SenderKeys> {
	const point = base64UrlDecode(publicKey);
	const coordinates = point ? pointToJwkCoordinates(point) : null;
	if (!point || !coordinates) throw new Error("Sender public key must be an uncompressed P-256 point");
	const key = await crypto.subtle.importKey(
		"jwk",
		{ kty: "EC", crv: "P-256", ...coordinates, d: privateKey, ext: true },
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		["deriveBits"],
	);
	return { privateKey: key, publicKey: point };
}

/**
 * Encrypts a push message for one subscription with aes128gcm (RFC 8291 §4):
 * a single record whose header carries the salt, the record size and the
 * sender's ephemeral public key. `salt` and `senderKeys` are only passed by
 * tests; real messages draw fresh ones.
 */
export async function encryptPushPayload(
	plaintext: Uint8Array,
	subscription: { p256dh: string; auth: string },
	options: { salt?: Uint8Array; senderKeys?: SenderKeys } = {},
): Promise<Bytes> {
	if (plaintext.length > MAX_PUSH_PLAINTEXT) throw new Error(`Push payload is ${plaintext.length} bytes; the limit is ${MAX_PUSH_PLAINTEXT}`);
	const userAgentPublicKey = base64UrlDecode(subscription.p256dh);
	const authSecret = base64UrlDecode(subscription.auth);
	if (!userAgentPublicKey || !pointToJwkCoordinates(userAgentPublicKey)) throw new Error("Subscription p256dh is not a P-256 public key");
	if (!authSecret || authSecret.length !== 16) throw new Error("Subscription auth secret must be 16 bytes");

	const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const sender = options.senderKeys ?? await generateSenderKeys();
	const userAgentKey = await crypto.subtle.importKey("raw", userAgentPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: userAgentKey }, sender.privateKey, 256));
	const { cek, nonce } = await derivePushKeys({ ecdhSecret, authSecret, userAgentPublicKey, senderPublicKey: sender.publicKey, salt });

	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	// The last (here only) record ends with the 0x02 padding delimiter.
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concatBytes(plaintext, new Uint8Array([0x02])));

	const recordSize = new Uint8Array(4);
	new DataView(recordSize.buffer).setUint32(0, PUSH_RECORD_SIZE);
	return concatBytes(salt, recordSize, new Uint8Array([sender.publicKey.length]), sender.publicKey, new Uint8Array(ciphertext));
}
