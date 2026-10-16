// Prints a fresh VAPID key pair for Web Push (RFC 8292) in the format
// Mailflare reads: the uncompressed P-256 public key and the 32-byte private
// scalar, both base64url. Uses Web Crypto only; the output is the same shape
// `npx web-push generate-vapid-keys` prints, so either works.
//
//   node scripts/generate-vapid-keys.mjs [mailto:you@example.com]

const toBase64Url = (bytes) => Buffer.from(bytes).toString("base64url");

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
const { d: privateKey } = await crypto.subtle.exportKey("jwk", pair.privateKey);
const subject = process.argv[2] ?? "mailto:admin@example.com";

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=${subject}`);
