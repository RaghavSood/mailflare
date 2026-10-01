import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { AuditLogInput } from "./types";

export async function createAuditLog(env: CloudflareEnv, input: AuditLogInput): Promise<void> {
	const db = getDb(env);
	await db.insert(auditLogs).values({
		id: newId("aud"),
		actorUserId: input.actorUserId ?? null,
		targetUserId: input.targetUserId ?? null,
		mailboxId: input.mailboxId ?? null,
		messageId: input.messageId ?? null,
		action: input.action,
		metadata: input.metadata ? JSON.stringify(input.metadata) : null,
	});
}

/** Many audit rows in one round trip. */
export async function createAuditLogs(env: CloudflareEnv, inputs: AuditLogInput[]): Promise<void> {
	if (inputs.length === 0) return;
	const db = getDb(env);
	const inserts = inputs.map((input) =>
		db.insert(auditLogs).values({
			id: newId("aud"),
			actorUserId: input.actorUserId ?? null,
			targetUserId: input.targetUserId ?? null,
			mailboxId: input.mailboxId ?? null,
			messageId: input.messageId ?? null,
			action: input.action,
			metadata: input.metadata ? JSON.stringify(input.metadata) : null,
		}));
	await db.batch(inserts as [typeof inserts[number], ...typeof inserts]);
}
