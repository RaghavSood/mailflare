import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Web Push message encryption (RFC 8291) and VAPID (RFC 8292), over Web Crypto only. */
const outDir = mkdtempSync(join(tmpdir(), "mailflare-push-crypto-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { base64UrlDecode, base64UrlEncode } from "./src/lib/push/encoding-utils.ts";
			export { derivePushKeys, encryptPushPayload, importSenderKeys, MAX_PUSH_PLAINTEXT } from "./src/lib/push/encrypt-utils.ts";
			export { createVapidJwt, isValidVapidSubject, vapidAudience, vapidAuthorization, verifyVapidJwt } from "./src/lib/push/vapid-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "push-crypto-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const push = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

/** The RFC prints its base64url values wrapped and with stray spaces. */
const b64 = (value) => value.replace(/\s+/g, "");
const bytes = (value) => push.base64UrlDecode(b64(value));

// RFC 8291 §5 and Appendix A, copied verbatim.
const RFC = {
	plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
	asPublic: `BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg
		Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8`,
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	uaPublic: `BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-
		JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4`,
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
	ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
	ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
	cek: "oIhVW04MRdy2XN9CiKLxTg",
	nonce: "4h_95klXJ5E_qnoN",
	header: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
		mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`,
	ciphertext: `8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs
		bI_0LpXMuGvnzQ`,
	body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
		mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
		pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

test("RFC 8291 Appendix A: key derivation reproduces the IKM, CEK and nonce", async () => {
	const keys = await push.derivePushKeys({
		ecdhSecret: bytes(RFC.ecdhSecret),
		authSecret: bytes(RFC.authSecret),
		userAgentPublicKey: bytes(RFC.uaPublic),
		senderPublicKey: bytes(RFC.asPublic),
		salt: bytes(RFC.salt),
	});
	assert.equal(push.base64UrlEncode(keys.ikm), RFC.ikm);
	assert.equal(push.base64UrlEncode(keys.cek), RFC.cek);
	assert.equal(push.base64UrlEncode(keys.nonce), RFC.nonce);
});

test("RFC 8291 §5: encryption with the example keys and salt produces the example body byte for byte", async () => {
	const senderKeys = await push.importSenderKeys(b64(RFC.asPublic), RFC.asPrivate);
	const body = await push.encryptPushPayload(
		bytes(RFC.plaintext),
		{ p256dh: b64(RFC.uaPublic), auth: RFC.authSecret },
		{ salt: bytes(RFC.salt), senderKeys },
	);
	// The example's body decodes to 144 octets (86 header + 41 plaintext + 1
	// delimiter + 16 tag); its "Content-Length: 145" line is one too many.
	assert.equal(body.length, 144);
	assert.equal(push.base64UrlEncode(body.subarray(0, 86)), b64(RFC.header));
	assert.equal(push.base64UrlEncode(body.subarray(86)), b64(RFC.ciphertext));
	assert.equal(push.base64UrlEncode(body), b64(RFC.body));
});

test("encryption draws a fresh salt and sender key for every message", async () => {
	const subscription = { p256dh: b64(RFC.uaPublic), auth: RFC.authSecret };
	const plaintext = new TextEncoder().encode("hello");
	const first = await push.encryptPushPayload(plaintext, subscription);
	const second = await push.encryptPushPayload(plaintext, subscription);
	assert.equal(first.length, 86 + plaintext.length + 1 + 16);
	assert.notDeepEqual(first.subarray(0, 16), second.subarray(0, 16));
	assert.notDeepEqual(first.subarray(21, 86), second.subarray(21, 86));
	// Record size 4096 and a 65-octet key id, as the header requires.
	assert.deepEqual([...first.subarray(16, 21)], [0, 0, 0x10, 0, 65]);
});

test("encryption refuses payloads that cannot fit one 4096-octet record and malformed keys", async () => {
	const subscription = { p256dh: b64(RFC.uaPublic), auth: RFC.authSecret };
	await assert.rejects(push.encryptPushPayload(new Uint8Array(push.MAX_PUSH_PLAINTEXT + 1), subscription), /limit/);
	await push.encryptPushPayload(new Uint8Array(push.MAX_PUSH_PLAINTEXT), subscription);
	await assert.rejects(push.encryptPushPayload(new Uint8Array(1), { ...subscription, auth: "AAAA" }), /16 bytes/);
	await assert.rejects(push.encryptPushPayload(new Uint8Array(1), { ...subscription, p256dh: RFC.authSecret }), /P-256/);
});

async function generateVapidConfig() {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const publicKey = push.base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
	const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
	return { publicKey, privateKey: d, subject: "mailto:admin@example.com" };
}

test("VAPID JWT round-trips: ES256 signature verifies with the public key and carries aud, exp and sub", async () => {
	const config = await generateVapidConfig();
	const endpoint = "https://fcm.googleapis.com/fcm/send/abc:def?x=1";
	const now = Date.UTC(2026, 9, 14, 12, 0, 0);
	const token = await push.createVapidJwt(config, push.vapidAudience(endpoint), now);
	const [header] = token.split(".");
	assert.deepEqual(JSON.parse(new TextDecoder().decode(push.base64UrlDecode(header))), { typ: "JWT", alg: "ES256" });
	const claims = await push.verifyVapidJwt(token, config.publicKey);
	assert.deepEqual(claims, { aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 60 * 60, sub: "mailto:admin@example.com" });
	// A raw r || s signature, not DER.
	assert.equal(push.base64UrlDecode(token.split(".")[2]).length, 64);

	const other = await generateVapidConfig();
	assert.equal(await push.verifyVapidJwt(token, other.publicKey), null);
	const [h, c, s] = token.split(".");
	const tampered = push.base64UrlEncode(new TextEncoder().encode(JSON.stringify({ aud: "https://evil.example", exp: 0, sub: "x" })));
	assert.equal(await push.verifyVapidJwt(`${h}.${tampered}.${s}`, config.publicKey), null);
	assert.ok(c);
});

test("VAPID Authorization header names the token and the public key; subject must be mailto: or https:", async () => {
	const config = await generateVapidConfig();
	const header = await push.vapidAuthorization(config, "https://updates.push.services.mozilla.com/wpush/v2/abc");
	const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
	assert.ok(match);
	assert.equal(match[2], config.publicKey);
	assert.equal((await push.verifyVapidJwt(match[1], config.publicKey))?.aud, "https://updates.push.services.mozilla.com");
	assert.equal(push.isValidVapidSubject("mailto:ops@example.com"), true);
	assert.equal(push.isValidVapidSubject("https://mail.example.com"), true);
	assert.equal(push.isValidVapidSubject("http://mail.example.com"), false);
	assert.equal(push.isValidVapidSubject("ops@example.com"), false);
});
