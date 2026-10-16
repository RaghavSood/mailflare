import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, before, describe } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * API key authentication (digest lookup, the bcrypt fallback for keys minted
 * before migration 0039 and its lazy upgrade, the throttled lastUsedAt write),
 * the batched sendable-address loader behind Identity/get, and the worker.ts
 * helpers that mount JMAP ahead of Next. The database parts run against the
 * repository's migrations in an in-memory SQLite database through the
 * self-hosted runtime's D1-compatible wrapper, as tests/jmap-changes.test.mjs does.
 */
const cacheDir = join(root, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "mailflare-jmap-auth-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { users, domains, mailboxes, mailboxAliases, apiKeys } from "./src/db/schema/index.ts";
			export { generateApiKey } from "./src/lib/api-keys.ts";
			export { authenticateApiKeyValue, authenticateApiRequest } from "./src/lib/api/key-auth.ts";
			export { apiKeyFromAuthorization, apiKeyPrefix, apiKeyRowWrite, digestApiKey, isLastUsedFresh, LAST_USED_WRITE_INTERVAL_MS } from "./src/lib/api/key-auth-utils.ts";
			export { getMailboxDomainAddresses, getMailboxDomainAddressesByMailbox } from "./src/lib/mailboxes/domain-addresses.ts";
			export { composeMailboxDomainAddresses } from "./src/lib/mailboxes/domain-addresses-utils.ts";
			export { processRequest, validateRequest } from "./src/lib/jmap/processor.ts";
			export { isJmapPath, withDefaultHeaders } from "./worker-utils.ts";
			export { eq } from "drizzle-orm";
			import bcrypt from "bcryptjs";
			export const hashSync = bcrypt.hashSync;
		`,
		resolveDir: root,
		sourcefile: "jmap-auth-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3"],
	logLevel: "silent",
});

const m = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const USER = { id: "usr_auth", email: "owner@example.test" };
const OTHER = { id: "usr_other", email: "other@example.test" };

let database;
let db;
let env;

before(async () => {
	database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, join(root, "drizzle", "migrations"));
	db = m.createDb(database);
	env = { DB: database };
	await db.insert(m.users).values([
		{ id: USER.id, email: USER.email, passwordHash: "x", name: "Owner" },
		{ id: OTHER.id, email: OTHER.email, passwordHash: "x", name: "Other" },
	]);
});

/** SQL of every statement the database prepares while `run` executes. */
async function recordStatements(run) {
	const prepared = [];
	const original = database.prepare;
	database.prepare = (sql) => {
		prepared.push(sql);
		return original.call(database, sql);
	};
	try {
		await run();
	} finally {
		database.prepare = original;
	}
	return prepared;
}

let keyCounter = 0;

/** A key row as the dashboard writes it today (with a digest), or as it did before 0039 (`legacy`: bcrypt only). */
async function insertKey({ legacy = false, userId = USER.id, scopes = ["jmap"], lastUsedAt = null, fullKey } = {}) {
	keyCounter += 1;
	const generated = await m.generateApiKey();
	const key = fullKey ?? generated.fullKey;
	const id = `key_${keyCounter}`;
	await db.insert(m.apiKeys).values({
		id,
		userId,
		name: `test ${keyCounter}`,
		prefix: m.apiKeyPrefix(key),
		// Cost 4 keeps the suite fast; the stored hash carries its own cost.
		keyHash: m.hashSync(key, 4),
		keyDigest: legacy ? null : await m.digestApiKey(key),
		scopes: JSON.stringify(scopes),
		lastUsedAt,
	});
	return { id, key };
}

async function keyRow(id) {
	const [row] = await db.select().from(m.apiKeys).where(m.eq(m.apiKeys.id, id));
	return row;
}

const isWrite = (sql) => /^\s*update/i.test(sql);
const isLegacyLookup = (sql) => /"api_keys"\."prefix" = \?/.test(sql);

describe("key-auth-utils", () => {
	test("the digest is lower-case hex SHA-256 of the whole key", async () => {
		assert.equal(await m.digestApiKey("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		const { fullKey, digest, prefix } = await m.generateApiKey();
		assert.match(digest, /^[0-9a-f]{64}$/);
		assert.equal(digest, await m.digestApiKey(fullKey));
		assert.equal(prefix, fullKey.slice(0, 12));
		assert.match(fullKey, /^ep_/);
	});

	test("lastUsedAt counts as fresh for one interval and no longer", () => {
		const now = new Date("2026-10-16T12:00:00Z");
		const ago = (ms) => new Date(now.getTime() - ms);
		assert.equal(m.isLastUsedFresh(null, now), false);
		assert.equal(m.isLastUsedFresh(ago(0), now), true);
		assert.equal(m.isLastUsedFresh(ago(m.LAST_USED_WRITE_INTERVAL_MS - 1), now), true);
		assert.equal(m.isLastUsedFresh(ago(m.LAST_USED_WRITE_INTERVAL_MS), now), false);
	});

	test("a matched row writes the digest when it has none and lastUsedAt only when stale", () => {
		const now = new Date("2026-10-16T12:00:00Z");
		const fresh = new Date(now.getTime() - 1_000);
		const stale = new Date(now.getTime() - 120_000);
		assert.equal(m.apiKeyRowWrite({ keyDigest: "d", lastUsedAt: fresh }, "d", now), null);
		assert.deepEqual(m.apiKeyRowWrite({ keyDigest: "d", lastUsedAt: stale }, "d", now), { lastUsedAt: now });
		assert.deepEqual(m.apiKeyRowWrite({ keyDigest: "d", lastUsedAt: null }, "d", now), { lastUsedAt: now });
		assert.deepEqual(m.apiKeyRowWrite({ keyDigest: null, lastUsedAt: fresh }, "d", now), { keyDigest: "d" });
		assert.deepEqual(m.apiKeyRowWrite({ keyDigest: null, lastUsedAt: null }, "d", now), { keyDigest: "d", lastUsedAt: now });
	});

	test("the key comes from a Bearer token or the Basic password", () => {
		const basic = (value) => `Basic ${Buffer.from(value).toString("base64")}`;
		assert.equal(m.apiKeyFromAuthorization("Bearer ep_abc"), "ep_abc");
		assert.equal(m.apiKeyFromAuthorization(basic("anyone:ep_abc")), "ep_abc");
		assert.equal(m.apiKeyFromAuthorization(basic(":ep_abc")), "ep_abc");
		assert.equal(m.apiKeyFromAuthorization(basic("ep_abc")), "ep_abc");
		assert.equal(m.apiKeyFromAuthorization("Basic %%%"), null);
		assert.equal(m.apiKeyFromAuthorization("Digest abc"), null);
		assert.equal(m.apiKeyFromAuthorization(""), null);
		assert.equal(m.apiKeyFromAuthorization(null), null);
	});
});

describe("authenticateApiKeyValue", () => {
	test("a current key is found by digest in one query, with its user, and writes nothing while lastUsedAt is fresh", async () => {
		const { id, key } = await insertKey({ scopes: ["jmap", "read"] });
		let result;
		const first = await recordStatements(async () => {
			result = await m.authenticateApiKeyValue(env, key);
		});
		assert.equal(result.userId, USER.id);
		assert.equal(result.email, USER.email);
		assert.equal(result.user.name, "Owner");
		assert.deepEqual(result.scopes, ["jmap", "read"]);
		assert.equal(first.length, 2, first.join("\n"));
		assert.match(first[0], /"api_keys"\."key_digest" = \?/);
		assert.match(first[0], /inner join "users"/);
		assert.ok(isWrite(first[1]), "the first use stamps lastUsedAt");
		assert.ok((await keyRow(id)).lastUsedAt);

		const second = await recordStatements(() => m.authenticateApiKeyValue(env, key));
		assert.equal(second.length, 1, second.join("\n"));
		assert.ok(!second.some(isWrite));
		assert.ok(!second.some(isLegacyLookup));
	});

	test("a stale lastUsedAt is refreshed, behind the WHERE guard", async () => {
		const stale = new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60_000);
		const { id, key } = await insertKey({ lastUsedAt: stale });
		const statements = await recordStatements(() => m.authenticateApiKeyValue(env, key));
		const writes = statements.filter(isWrite);
		assert.equal(writes.length, 1);
		assert.match(writes[0], /"last_used_at" is null or "api_keys"\."last_used_at" < \?/);
		assert.ok((await keyRow(id)).lastUsedAt.getTime() > stale.getTime());
	});

	test("a key minted before the digest column passes bcrypt once, gets its digest, then takes the indexed path", async () => {
		const { id, key } = await insertKey({ legacy: true, scopes: ["jmap"] });
		assert.equal((await keyRow(id)).keyDigest, null);

		let result;
		const first = await recordStatements(async () => {
			result = await m.authenticateApiKeyValue(env, key);
		});
		assert.equal(result?.userId, USER.id);
		assert.equal(first.length, 3, first.join("\n"));
		assert.ok(isLegacyLookup(first[1]), "the miss falls back to the prefix lookup");
		assert.match(first[1], /"api_keys"\."key_digest" is null/);
		assert.ok(isWrite(first[2]));
		assert.match(first[2], /"key_digest" = \?/);
		const upgraded = await keyRow(id);
		assert.equal(upgraded.keyDigest, await m.digestApiKey(key));
		assert.ok(upgraded.lastUsedAt);

		const second = await recordStatements(() => m.authenticateApiKeyValue(env, key));
		assert.equal(second.length, 1, second.join("\n"));
	});

	test("an upgrade still writes the digest when lastUsedAt is fresh", async () => {
		const { id, key } = await insertKey({ legacy: true, lastUsedAt: new Date() });
		const statements = await recordStatements(() => m.authenticateApiKeyValue(env, key));
		assert.equal(statements.filter(isWrite).length, 1);
		assert.equal((await keyRow(id)).keyDigest, await m.digestApiKey(key));
	});

	test("a wrong key sharing an upgraded key's prefix is refused without a bcrypt candidate", async () => {
		const { key } = await insertKey();
		const wrong = `${key.slice(0, 12)}${"x".repeat(key.length - 12)}`;
		let result = "unset";
		const statements = await recordStatements(async () => {
			result = await m.authenticateApiKeyValue(env, wrong);
		});
		assert.equal(result, null);
		assert.equal(statements.length, 2);
		assert.ok(!statements.some(isWrite));
		const legacyRows = await db.select().from(m.apiKeys).where(m.eq(m.apiKeys.prefix, key.slice(0, 12)));
		assert.ok(legacyRows.every((row) => row.keyDigest !== null), "the only row under that prefix has a digest, so the fallback query skips it");
	});

	test("a wrong key sharing a legacy key's prefix is refused and upgrades nothing", async () => {
		const { id, key } = await insertKey({ legacy: true });
		const wrong = `${key.slice(0, 12)}${"x".repeat(key.length - 12)}`;
		assert.equal(await m.authenticateApiKeyValue(env, wrong), null);
		assert.equal((await keyRow(id)).keyDigest, null);
	});

	test("deleting the row revokes the key on its next request, current or legacy", async () => {
		for (const legacy of [false, true]) {
			const { id, key } = await insertKey({ legacy });
			assert.ok(await m.authenticateApiKeyValue(env, key));
			await db.delete(m.apiKeys).where(m.eq(m.apiKeys.id, id));
			assert.equal(await m.authenticateApiKeyValue(env, key), null);
		}
	});

	test("a disabled user's keys are refused on both paths", async () => {
		const current = await insertKey({ userId: OTHER.id });
		const legacy = await insertKey({ userId: OTHER.id, legacy: true });
		await db.update(m.users).set({ disabled: true }).where(m.eq(m.users.id, OTHER.id));
		try {
			assert.equal(await m.authenticateApiKeyValue(env, current.key), null);
			assert.equal(await m.authenticateApiKeyValue(env, legacy.key), null);
			assert.equal((await keyRow(legacy.id)).keyDigest, null);
		} finally {
			await db.update(m.users).set({ disabled: false }).where(m.eq(m.users.id, OTHER.id));
		}
	});

	test("blank keys and whitespace around a key", async () => {
		const { key } = await insertKey();
		assert.equal(await m.authenticateApiKeyValue(env, ""), null);
		assert.equal(await m.authenticateApiKeyValue(env, "   "), null);
		assert.equal((await m.authenticateApiKeyValue(env, ` ${key}\n`))?.userId, USER.id);
	});

	test("authenticateApiRequest reads Bearer and Basic", async () => {
		const { key } = await insertKey();
		const request = (authorization) => new Request("https://mail.example.test/jmap/session", { headers: authorization ? { Authorization: authorization } : {} });
		assert.equal((await m.authenticateApiRequest(env, request(`Bearer ${key}`)))?.userId, USER.id);
		assert.equal((await m.authenticateApiRequest(env, request(`Basic ${Buffer.from(`me:${key}`).toString("base64")}`)))?.userId, USER.id);
		assert.equal(await m.authenticateApiRequest(env, request(null)), null);
		assert.equal(await m.authenticateApiRequest(env, request("Basic !!!")), null);
	});
});

describe("sendable addresses for Identity/get", () => {
	const MAILBOXES = [
		// Uses all domains: support@ on the owner's other active domains, minus those where
		// another mailbox or alias already claims "support" (after dots and +tags are dropped).
		{ id: "mbx_support", domainId: "dom_com", localPart: "support", displayName: "Support", useAllDomains: true },
		{ id: "mbx_billing", domainId: "dom_com", localPart: "billing", displayName: "Billing", useAllDomains: true },
		{ id: "mbx_ops", domainId: "dom_org", localPart: "ops", displayName: "Operations", useAllDomains: false },
		{ id: "mbx_dotted", domainId: "dom_org", localPart: "sup.port", displayName: "Dotted", useAllDomains: false },
		{ id: "mbx_tagged", domainId: "dom_io", localPart: "billing+eu", displayName: "Tagged", useAllDomains: false },
		{ id: "mbx_upper", domainId: "dom_io", localPart: "Sales", displayName: "Sales", useAllDomains: true },
	];

	before(async () => {
		await db.insert(m.domains).values([
			{ id: "dom_com", userId: USER.id, hostname: "example.com", zoneId: "z1", status: "active" },
			{ id: "dom_org", userId: USER.id, hostname: "example.org", zoneId: "z2", status: "active" },
			{ id: "dom_net", userId: USER.id, hostname: "example.net", zoneId: "z3", status: "active" },
			{ id: "dom_io", userId: USER.id, hostname: "Example.IO", zoneId: "z4", status: "active" },
			{ id: "dom_pending", userId: USER.id, hostname: "pending.test", zoneId: "z5", status: "pending" },
			{ id: "dom_other", userId: OTHER.id, hostname: "other.test", zoneId: "z6", status: "active" },
		]);
		await db.insert(m.mailboxes).values(MAILBOXES.map(({ id, domainId, localPart, displayName, useAllDomains }) => ({ id, userId: USER.id, domainId, localPart, displayName, useAllDomains })));
		// Another user's mailbox with the same local part, on that user's own domain.
		await db.insert(m.mailboxes).values({ id: "mbx_foreign", userId: OTHER.id, domainId: "dom_other", localPart: "support", useAllDomains: true });
		await db.insert(m.mailboxAliases).values([
			{ id: "ali_1", mailboxId: "mbx_ops", domainId: "dom_org", localPart: "help" },
			{ id: "ali_2", mailboxId: "mbx_ops", domainId: "dom_net", localPart: "ops" },
			{ id: "ali_3", mailboxId: "mbx_ops", domainId: "dom_net", localPart: "billing" },
			{ id: "ali_4", mailboxId: "mbx_support", domainId: "dom_pending", localPart: "helpdesk" },
			{ id: "ali_5", mailboxId: "mbx_support", domainId: "dom_com", localPart: "Support" },
			{ id: "ali_6", mailboxId: "mbx_upper", domainId: "dom_com", localPart: "deals" },
		]);
	});

	test("the batched loader answers exactly what the one-mailbox loader does", async () => {
		const inputs = MAILBOXES.map(({ id, domainId, localPart, useAllDomains }) => ({ id, domainId, localPart, useAllDomains }));
		inputs.push({ id: "mbx_foreign", domainId: "dom_other", localPart: "support", useAllDomains: true });
		inputs.push({ id: "mbx_gone", domainId: "dom_missing", localPart: "ghost", useAllDomains: true });
		const one = new Map();
		for (const input of inputs) one.set(input.id, await m.getMailboxDomainAddresses(db, input));
		const batched = await m.getMailboxDomainAddressesByMailbox(db, inputs);
		assert.deepEqual([...batched.entries()], [...one.entries()]);

		assert.deepEqual(batched.get("mbx_support"), ["support@example.com", "support@example.net", "support@example.io", "helpdesk@pending.test"]);
		assert.deepEqual(batched.get("mbx_billing"), ["billing@example.com", "billing@example.org"]);
		assert.deepEqual(batched.get("mbx_ops"), ["ops@example.org", "help@example.org", "ops@example.net", "billing@example.net"]);
		assert.deepEqual(batched.get("mbx_upper"), ["sales@example.io", "sales@example.com", "sales@example.org", "sales@example.net", "deals@example.com"]);
		assert.deepEqual(batched.get("mbx_foreign"), ["support@other.test"]);
		assert.deepEqual(batched.get("mbx_gone"), []);
		assert.equal((await m.getMailboxDomainAddressesByMailbox(db, [])).size, 0);
	});

	test("the composer keeps first positions and ignores the domain lists without useAllDomains", () => {
		const sources = {
			mailbox: { id: "a", domainId: "d1", localPart: "Me", useAllDomains: false },
			primaryHostname: "One.test",
			aliasAddresses: ["me@one.test", "alias@two.test"],
			availableDomains: [{ id: "d2", hostname: "two.test" }],
			assignedMailboxes: [],
			assignedAliases: [],
		};
		assert.deepEqual(m.composeMailboxDomainAddresses(sources), ["me@one.test", "alias@two.test"]);
		assert.deepEqual(m.composeMailboxDomainAddresses({ ...sources, mailbox: { ...sources.mailbox, useAllDomains: true } }), ["me@one.test", "me@two.test", "alias@two.test"]);
		assert.deepEqual(
			m.composeMailboxDomainAddresses({ ...sources, mailbox: { ...sources.mailbox, useAllDomains: true }, assignedAliases: [{ mailboxId: "b", domainId: "d2", localPart: "m.e+x" }] }),
			["me@one.test", "alias@two.test"],
		);
	});

	test("Identity/get lists every sendable address in a fixed number of queries", async () => {
		const key = await insertKey();
		const auth = await m.authenticateApiKeyValue(env, key.key);
		const ctx = { env, db, auth, accountId: USER.id, origin: "http://localhost", createdIds: {} };
		let response;
		const statements = await recordStatements(async () => {
			response = await m.processRequest(ctx, m.validateRequest({
				using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
				methodCalls: [["Identity/get", { accountId: USER.id, ids: null }, "i"]],
			}));
		});
		const [[name, result]] = response.methodResponses;
		assert.equal(name, "Identity/get");
		const emails = result.list.map((identity) => identity.email);
		assert.deepEqual(emails, [
			"support@example.com", "support@example.net", "support@example.io", "helpdesk@pending.test",
			"billing@example.com", "billing@example.org",
			"ops@example.org", "help@example.org", "ops@example.net", "billing@example.net",
			"sup.port@example.org",
			"billing+eu@example.io",
			"sales@example.io", "sales@example.com", "sales@example.org", "sales@example.net", "deals@example.com",
		]);
		assert.equal(result.list[0].name, "Support");
		// The owned-mailboxes join and license check, then the five address queries — none per mailbox.
		const addressQueries = statements.filter((sql) => /from "(domains|mailbox_aliases|mailboxes)"/.test(sql) && !/inner join "domains" on "mailboxes"/.test(sql));
		assert.equal(addressQueries.length, 5, addressQueries.join("\n"));
	});
});

describe("worker.ts JMAP mount", () => {
	test("only JMAP paths go to the JMAP handler", () => {
		for (const path of ["/jmap", "/jmap/", "/jmap/session", "/jmap/api", "/jmap/download/a/b/c", "/.well-known/jmap"]) assert.equal(m.isJmapPath(path), true, path);
		for (const path of ["/", "/jmapx", "/jmap-old/session", "/api/jmap", "/.well-known/jmap/", "/.well-known/jmapx", "/v2/inbox"]) assert.equal(m.isJmapPath(path), false, path);
	});

	test("default headers fill gaps without replacing the response's own", async () => {
		const original = new Response("body", { status: 201, statusText: "Created", headers: { "Content-Security-Policy": "default-src 'none'; sandbox", "X-Own": "1" } });
		const out = m.withDefaultHeaders(original, [
			{ key: "Content-Security-Policy", value: "default-src 'self'" },
			{ key: "X-Content-Type-Options", value: "nosniff" },
		]);
		assert.equal(out.status, 201);
		assert.equal(out.statusText, "Created");
		assert.equal(out.headers.get("content-security-policy"), "default-src 'none'; sandbox");
		assert.equal(out.headers.get("x-content-type-options"), "nosniff");
		assert.equal(out.headers.get("x-own"), "1");
		assert.equal(await out.text(), "body");
		const redirect = m.withDefaultHeaders(Response.redirect("https://mail.example.test/jmap/session", 301), [{ key: "X-Frame-Options", value: "SAMEORIGIN" }]);
		assert.equal(redirect.status, 301);
		assert.equal(redirect.headers.get("location"), "https://mail.example.test/jmap/session");
		assert.equal(redirect.headers.get("x-frame-options"), "SAMEORIGIN");
	});
});
