import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Header parsing, envelope-recipient display and custom-sender checks are pure,
 * so they are bundled with esbuild (for the `@/*` alias) and exercised directly.
 */
const outDir = mkdtempSync(join(tmpdir(), "mailflare-envelope-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export * from "./src/lib/email/header-utils.ts";
			export { limitThreadCandidates } from "./src/lib/email/threading.ts";
			export { domainRoutingRuleSchema } from "./src/lib/validators.ts";
			export { getHiddenEnvelopeRecipient, summarizeAuthentication } from "./src/components/messages/message-header-details-utils.ts";
			export { getComposeSenderAddresses, validateCustomSender } from "./src/components/compose/sender-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "envelope-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const {
	buildMessageHeaderDetails,
	getEnvelopeRecipient,
	getHeaderBlock,
	parseHeaderList,
	limitThreadCandidates,
	domainRoutingRuleSchema,
	getHiddenEnvelopeRecipient,
	summarizeAuthentication,
	getComposeSenderAddresses,
	validateCustomSender,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const encode = (text) => {
	const bytes = new TextEncoder().encode(text);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

// Shaped like a Fastmail delivery to a catch-all alias with "Undisclosed recipients" in To.
const fastmailRaw = [
	"Return-Path: <prvs=123=trading@sender.example>",
	"Received: from mx-internal.internal (mx-internal.internal [10.202.2.47])",
	"\t by store (Cyrus) with LMTPA; Sun, 23 Aug 2026 23:09:48 -0400",
	"X-Resolved-to: me@example.com",
	"X-Delivered-to: alias@example.com",
	"Received: from relay.sender.example (relay.sender.example [139.138.42.120])",
	"\t(using TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits))",
	"\tby mx.receiver.example (Postfix) with ESMTPS id 5166C20E00C1",
	"\tfor <alias@example.com>; Sun, 23 Aug 2026 23:09:36 -0400 (EDT)",
	"Authentication-Results: mx.receiver.example;",
	"    x-ptr=pass smtp.helo=relay.sender.example",
	"Authentication-Results: mx.receiver.example;",
	"    dkim=fail (body has been altered, 2048-bit rsa key sha256)",
	"      header.d=tenant.onmicrosoft.example header.b=LThTQ2QI;",
	"    dkim=pass (2048-bit rsa key sha256) header.d=sender.example",
	"      header.i=@sender.example header.s=cesa;",
	"    dmarc=pass policy.published-domain-policy=none",
	"      header.from=sender.example;",
	"    spf=pass smtp.mailfrom=\"prvs=123=trading@sender.example\"",
	"      smtp.helo=relay.sender.example",
	"Authentication-Results: relay.sender.example; spf=Pass smtp.mailfrom=trading@sender.example; dkim=hardfail",
	"From: Trading <trading@sender.example>",
	"Subject: Market Update",
	"Date: Mon, 24 Aug 2026 03:09:22 +0000",
	"Message-ID: <abc@sender.example>",
	"To: Undisclosed recipients:;",
	"",
	"Body",
].join("\r\n");

// Shaped like Cloudflare Email Routing: no TLS detail, DKIM reported by header.i only.
const cloudflareRaw = [
	"Received: from relay.sender.example (139.138.42.120)",
	"        by cloudflare-email.net (cloudflare) id w94FynVOcmr2",
	"        for <ALIAS@example.com>; Thu, 24 Sep 2026 02:18:26 +0000",
	"Authentication-Results: mx.cloudflare.net;",
	"\tdkim=pass header.i=@sender.example header.s=cesa header.b=mDZgqnzJ;",
	"\tdmarc=pass header.from=sender.example policy.dmarc=none;",
	"\tspf=pass (mx.cloudflare.net: domain of ops@sender.example designates 139.138.42.120 as permitted sender) smtp.mailfrom=ops@sender.example;",
	"From: Ops <ops@sender.example>",
	"To: \"ALIAS@EXAMPLE.COM\" <ALIAS@EXAMPLE.COM>",
	"Return-Path: ops@sender.example",
	"",
	"Body",
].join("\r\n");

test("headers keep their order and unfold continuation lines", () => {
	const headers = parseHeaderList(getHeaderBlock(encode(fastmailRaw)));
	assert.equal(headers[0].name, "Return-Path");
	const received = headers.filter((header) => header.name === "Received");
	assert.equal(received.length, 2);
	assert.match(received[1].value, /^from relay\.sender\.example .* by mx\.receiver\.example /);
	assert.ok(!headers.some((header) => header.name === "Body"));
});

test("the envelope recipient comes from the receiving server's delivery headers", () => {
	assert.equal(getEnvelopeRecipient(parseHeaderList(getHeaderBlock(encode(fastmailRaw)))), "alias@example.com");
	const postfix = parseHeaderList("Delivered-To: final@example.com\r\nX-Original-To: Original@Example.com");
	assert.equal(getEnvelopeRecipient(postfix), "original@example.com");
	assert.equal(getEnvelopeRecipient(parseHeaderList("To: someone@example.com")), null);
});

test("details report only the topmost server's authentication, with signers and transport", () => {
	const details = buildMessageHeaderDetails(parseHeaderList(getHeaderBlock(encode(fastmailRaw))));
	assert.equal(details.authservId, "mx.receiver.example");
	assert.deepEqual(
		details.authentication.map((check) => `${check.method}=${check.result}@${check.domain}`),
		[
			"x-ptr=pass@null",
			"dkim=fail@tenant.onmicrosoft.example",
			"dkim=pass@sender.example",
			"dmarc=pass@sender.example",
			"spf=pass@sender.example",
		],
	);
	assert.deepEqual(details.signedBy, ["sender.example"]);
	assert.equal(details.mailedBy, "sender.example");
	assert.equal(details.transportSecurity, "TLSv1.3");
	assert.equal(details.deliveredTo, "alias@example.com");
	assert.equal(details.messageId, "<abc@sender.example>");
});

test("Cloudflare deliveries: DKIM domain from header.i, stored envelope wins, unknown transport stays null", () => {
	const details = buildMessageHeaderDetails(parseHeaderList(getHeaderBlock(encode(cloudflareRaw))), {
		deliveredTo: "alias@example.com",
		envelopeFrom: "bounce@sender.example",
	});
	assert.equal(details.authservId, "mx.cloudflare.net");
	assert.deepEqual(details.signedBy, ["sender.example"]);
	assert.equal(details.deliveredTo, "alias@example.com");
	assert.equal(details.envelopeFrom, "bounce@sender.example");
	assert.equal(details.transportSecurity, null);
	const summary = summarizeAuthentication(details.authentication);
	assert.deepEqual(summary.map((item) => `${item.label}:${item.tone}`), ["SPF:pass", "DKIM:pass", "DMARC:pass"]);
});

test("DKIM passes when any signature verifies; a failing SPF check fails SPF", () => {
	const details = buildMessageHeaderDetails(parseHeaderList(getHeaderBlock(encode(fastmailRaw))));
	const dkim = summarizeAuthentication(details.authentication).find((item) => item.method === "dkim");
	assert.equal(dkim.tone, "pass");
	assert.equal(dkim.checks.length, 2);
	const spf = summarizeAuthentication([
		{ method: "spf", result: "pass", domain: "helo.example" },
		{ method: "spf", result: "softfail", domain: "sender.example" },
	]);
	assert.equal(spf[0].tone, "fail");
});

test("the envelope recipient is shown only when To and Cc do not already list it", () => {
	const base = { id: "m", direction: "inbound", fromAddr: "a@b.c", subject: null, createdAt: "", bccAddr: null };
	assert.equal(getHiddenEnvelopeRecipient({ ...base, toAddr: "", ccAddr: null, deliveredTo: "alias@example.com" }), "alias@example.com");
	assert.equal(
		getHiddenEnvelopeRecipient({ ...base, toAddr: "\"ALIAS\" <ALIAS@EXAMPLE.COM>", ccAddr: null, deliveredTo: "alias@example.com" }),
		null,
	);
	assert.equal(getHiddenEnvelopeRecipient({ ...base, direction: "outbound", toAddr: "", ccAddr: null, deliveredTo: "x@y.z" }), null);
	assert.equal(getHiddenEnvelopeRecipient({ ...base, toAddr: "", ccAddr: null, deliveredTo: null }), null);
});

test("a custom sender must be a plain address on one of the mailbox's catch-all domains", () => {
	const mailbox = { id: "mbx", localPart: "me", hostname: "example.com", senderAddresses: ["me@example.com"], catchAllHostnames: ["example.com"] };
	assert.deepEqual(validateCustomSender(" Alias@Example.com ", mailbox), { address: "alias@example.com" });
	assert.ok("error" in validateCustomSender("alias@other.com", mailbox));
	assert.ok("error" in validateCustomSender("\"a b\"@example.com", mailbox));
	assert.ok("error" in validateCustomSender("a,b@example.com", mailbox));
	assert.ok("error" in validateCustomSender("alias@example.com", { ...mailbox, catchAllHostnames: [] }));
});

test("a reply draft's alias sender joins its own mailbox's From options only", () => {
	const mailbox = { id: "mbx", localPart: "me", hostname: "example.com", senderAddresses: ["me@example.com"] };
	assert.deepEqual(getComposeSenderAddresses(mailbox, { mailboxId: "mbx", address: "alias@example.com" }), ["me@example.com", "alias@example.com"]);
	assert.deepEqual(getComposeSenderAddresses(mailbox, { mailboxId: "other", address: "alias@example.com" }), ["me@example.com"]);
	assert.deepEqual(getComposeSenderAddresses(mailbox, { mailboxId: "mbx", address: "me@example.com" }), ["me@example.com"]);
	assert.deepEqual(getComposeSenderAddresses(null, null), []);
});

test("long References chains keep the root and the most recent ancestors under D1's parameter limit", () => {
	const ids = Array.from({ length: 60 }, (_, index) => `id${index}@example.com`);
	const limited = limitThreadCandidates(ids);
	assert.equal(limited.length, 40);
	assert.equal(limited[0], "id0@example.com");
	assert.equal(limited.at(-1), "id59@example.com");
	// In-Reply-To plus these, each bound with and without brackets, plus mailbox and limit.
	assert.ok((limited.length + 1) * 2 + 2 <= 100);
	assert.deepEqual(limitThreadCandidates(ids.slice(0, 5)), ids.slice(0, 5));
});

test("the domain rule form's catch-all ('*', empty forwardTo) validates", () => {
	const base = {
		domainId: "dom",
		name: "",
		enabled: true,
		matchField: "recipient",
		matchValue: "*",
		action: "store",
		mailboxId: "mbx",
		forwardTo: "",
		keepCopy: false,
		rejectReason: "",
		priority: 100,
	};
	for (const matchOperator of ["regex", "exact", "contains"]) {
		const parsed = domainRoutingRuleSchema.safeParse({ ...base, matchOperator });
		assert.ok(parsed.success, JSON.stringify(parsed.error?.flatten()));
		assert.equal(parsed.data.forwardTo, null);
	}
	assert.equal(domainRoutingRuleSchema.safeParse({ ...base, matchOperator: "regex", matchValue: "(" }).success, false);
	assert.equal(domainRoutingRuleSchema.safeParse({ ...base, action: "forward", forwardTo: "not-an-email" }).success, false);
});
