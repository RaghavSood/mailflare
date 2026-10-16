import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import type { ApiKeyRouteParams } from "./types";

/**
 * Revoke an API key. Only the key's owner can revoke it; the key validator
 * reads the row on every request (by digest, or by prefix and hash for an old
 * key) and caches nothing, so deleting the row makes the key stop working on
 * its next request. Unknown ids and other users' keys both answer 404 so the
 * endpoint does not reveal which ids exist.
 */
export async function DELETE(request: Request, { params }: ApiKeyRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;

	const db = getDb(env);
	const [row] = await db
		.select({ id: apiKeys.id })
		.from(apiKeys)
		.where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)))
		.limit(1);
	if (!row) {
		return NextResponse.json({ error: "API key not found" }, { status: 404 });
	}

	await db.delete(apiKeys).where(eq(apiKeys.id, id));
	return NextResponse.json({ ok: true });
}
