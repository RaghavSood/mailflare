-- SHA-256 digest of the full API key, the verifier for every request. Keys are
-- high-entropy random tokens, so an indexed digest lookup replaces the cost-10
-- bcrypt compare per request. Rows written before this column existed keep a
-- null digest until their first successful bcrypt match fills it in. No
-- trigger watches api_keys. SQLite lets a unique index hold any number of nulls.
ALTER TABLE `api_keys` ADD `key_digest` text;--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_digest_idx` ON `api_keys` (`key_digest`);
