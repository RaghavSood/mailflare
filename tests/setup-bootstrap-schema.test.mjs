import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { splitSql } from "../scripts/migration-bundle-utils.mjs";

// Setup no longer carries its own bootstrap schema: migrateCleanDatabase (src/lib/setup/migration.ts)
// applies the bundled migrations through applyPendingMigrations. These tests build the same bundle
// generate-migration-bundle.mjs writes and apply it to an empty SQLite database the way the runner does.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(root, "drizzle/migrations");

function bundledMigrations() {
	return readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => ({ name, statements: splitSql(readFileSync(join(migrationsDirectory, name), "utf8")) }));
}

function bootstrap() {
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
	);
	for (const migration of bundledMigrations()) {
		db.exec("BEGIN");
		db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(migration.name);
		for (const statement of migration.statements) {
			try {
				db.exec(statement);
			} catch (error) {
				throw new Error(`${migration.name}: ${error.message}\n${statement}`);
			}
		}
		db.exec("COMMIT");
	}
	return db;
}

function columns(db, table) {
	return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

test("bootstrap records every committed migration so later deploys do not re-apply them", () => {
	const db = bootstrap();
	const recorded = db.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map((row) => row.name);
	const committed = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();
	assert.deepEqual(recorded, committed);
	for (const name of [
		"0013_add_license_settings.sql",
		"0021_add_mailbox_signature.sql",
		"0022_add_mailbox_auto_reply.sql",
		"0027_add_domain_sending_intent.sql",
		"0029_add_spam_protection.sql",
	]) {
		assert.ok(recorded.includes(name), `bootstrap did not record ${name}`);
	}
});

test("migration statements keep trigger bodies whole", () => {
	const statements = bundledMigrations().flatMap((migration) => migration.statements);
	const triggers = statements.filter((statement) => /^CREATE TRIGGER/i.test(statement));
	assert.ok(triggers.length > 0, "no triggers found in the migrations");
	for (const trigger of triggers) assert.match(trigger, /\bEND;?$/i);
});

test("fresh bootstrap schema accepts the current Drizzle mailbox and license inserts", () => {
	const db = bootstrap();
	const mailboxColumns = columns(db, "mailboxes");
	for (const column of ["signature", "auto_reply_enabled", "auto_reply_subject", "auto_reply_body"]) {
		assert.ok(mailboxColumns.includes(column), `mailboxes is missing ${column}`);
	}
	assert.ok(columns(db, "domains").includes("sending_requested"), "domains is missing sending_requested");
	for (const table of ["license_settings", "auto_reply_deliveries", "spam_token_stats", "spam_reputation", "spam_feedback"]) {
		assert.ok(columns(db, table).length > 0, `${table} was not created`);
	}
	const spamColumn = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%spam_protection_enabled%'")
		.all();
	assert.ok(spamColumn.length > 0, "no table has spam_protection_enabled");

	db.exec("INSERT INTO users (id,email,password_hash,name,created_at) VALUES ('u','a@b.c','x','n',1)");
	db.exec("INSERT INTO domains (id,user_id,hostname,zone_id,created_at) VALUES ('d','u','ex.com','z',1)");
	db.exec(`
		INSERT INTO mailboxes (
			id, user_id, domain_id, local_part, display_name,
			signature, auto_reply_enabled, auto_reply_subject, auto_reply_body, created_at
		) VALUES ('m','u','d','admin','admin','sig',0,'Out of office','',1)
	`);
	db.exec("INSERT INTO license_settings (id, instance_id, updated_at) VALUES ('default','inst',1)");
	db.exec("INSERT INTO auto_reply_deliveries (id, mailbox_id, recipient, sent_at) VALUES ('ar','m','x@y.z',1)");
	assert.equal(db.prepare("SELECT count(*) AS n FROM mailboxes").get().n, 1);
});
