import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The self-hosted runtime's D1 stand-in must give `batch` D1's semantics: atomic, and safe while other
 * requests run their own batches. A batch that awaited between BEGIN and COMMIT let a second request's
 * batch start inside it, and /v2/inbox answered 500 "cannot start a transaction within a transaction" (#34).
 */
const cacheDir = join(root, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "mailflare-node-sqlite-batch-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: { contents: `export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";`, resolveDir: root, sourcefile: "node-sqlite-batch-test-entry.js" },
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3"],
	logLevel: "silent",
});
const { SqliteDatabase } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

let count = 0;
function openDatabase() {
	count += 1;
	const database = new SqliteDatabase(join(outDir, `db-${count}.sqlite`));
	database.db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, batch INTEGER NOT NULL, label TEXT NOT NULL UNIQUE)");
	after(() => database.db.close());
	return database;
}

function insert(database, batch, label) {
	return database.prepare("INSERT INTO items (batch, label) VALUES (?, ?)").bind(batch, label);
}

test("concurrent batches run one after another instead of nesting transactions", async () => {
	const database = openDatabase();
	const batches = Array.from({ length: 40 }, (_, batch) => database.batch([
		insert(database, batch, `${batch}-a`),
		insert(database, batch, `${batch}-b`),
		database.prepare("SELECT count(*) AS n FROM items WHERE batch = ?").bind(batch),
		database.prepare("SELECT label FROM items WHERE batch = ? ORDER BY label").bind(batch),
	]));
	const settled = await Promise.allSettled(batches);
	const failures = settled.filter((result) => result.status === "rejected").map((result) => String(result.reason?.message ?? result.reason));
	assert.deepEqual(failures, []);
	settled.forEach((result, batch) => {
		const [first, second, counted, labels] = result.value;
		assert.equal(first.meta.changes, 1);
		assert.equal(second.meta.changes, 1);
		assert.deepEqual(counted.results, [{ n: 2 }]);
		assert.deepEqual(labels.results, [{ label: `${batch}-a` }, { label: `${batch}-b` }]);
	});
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM items").get().n, 80);
	assert.equal(database.db.inTransaction, false);
});

test("a batch with a failing statement leaves none of its writes, even among concurrent batches", async () => {
	const database = openDatabase();
	await database.batch([insert(database, 0, "taken")]);
	const settled = await Promise.allSettled([
		database.batch([insert(database, 1, "one-a"), insert(database, 1, "one-b")]),
		database.batch([insert(database, 2, "two-a"), insert(database, 2, "taken"), insert(database, 2, "two-c")]),
		database.batch([insert(database, 3, "three-a")]),
	]);
	assert.equal(settled[0].status, "fulfilled", String(settled[0].reason?.message));
	assert.equal(settled[1].status, "rejected");
	assert.match(String(settled[1].reason?.message), /UNIQUE constraint failed/);
	assert.equal(settled[2].status, "fulfilled", String(settled[2].reason?.message));
	const labels = database.db.prepare("SELECT label FROM items ORDER BY id").all().map((row) => row.label);
	assert.deepEqual(labels, ["taken", "one-a", "one-b", "three-a"]);
	assert.equal(database.db.inTransaction, false);
});

test("a statement run while a batch is pending sees the batch whole or not at all", async () => {
	const database = openDatabase();
	const pending = database.batch([insert(database, 1, "a"), insert(database, 1, "b")]);
	const seen = await database.prepare("SELECT count(*) AS n FROM items").first("n");
	await pending;
	assert.ok(seen === 0 || seen === 2, `saw ${seen} rows of a two-row batch`);
	assert.equal(await database.prepare("SELECT count(*) AS n FROM items").first("n"), 2);
});

test("batch returns D1-shaped results for reads, writes and RETURNING", async () => {
	const database = openDatabase();
	const [written, returned, read] = await database.batch([
		insert(database, 1, "x"),
		database.prepare("INSERT INTO items (batch, label) VALUES (?, ?) RETURNING id, label").bind(1, "y"),
		database.prepare("SELECT batch, label FROM items ORDER BY id"),
	]);
	assert.equal(written.success, true);
	assert.deepEqual(written.results, []);
	assert.equal(written.meta.last_row_id, 1);
	assert.deepEqual(returned.results, [{ id: 2, label: "y" }]);
	assert.deepEqual(read.results, [{ batch: 1, label: "x" }, { batch: 1, label: "y" }]);
	assert.deepEqual(await database.batch([]), []);
});
