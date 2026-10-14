import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { splitSql } from "./migration-bundle-utils.mjs";

const root = new URL("../", import.meta.url);
const migrationsDirectory = new URL("drizzle/migrations/", root);
const output = new URL("src/lib/migrations/bundle.json", root);

const migrations = readdirSync(migrationsDirectory)
	.filter((name) => name.endsWith(".sql"))
	.sort()
	.map((name) => ({
		name,
		statements: splitSql(readFileSync(new URL(name, migrationsDirectory), "utf8")),
	}));

writeFileSync(output, `${JSON.stringify({ migrations }, null, 2)}\n`);
