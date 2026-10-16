import type { users } from "@/db/schema";

export type ApiAuthResult = {
	userId: string;
	email: string;
	scopes: string[];
	user: typeof users.$inferSelect;
};

/** Columns a successful authentication updates on its `api_keys` row. */
export type ApiKeyRowWrite = { keyDigest?: string; lastUsedAt?: Date };
