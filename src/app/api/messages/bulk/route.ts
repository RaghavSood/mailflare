import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { applyMessageAction, MessageActionError } from "@/lib/messages/actions";
import type { BulkMessagePayload } from "./types";
import { isAllowedBulkMessageAction } from "./utils";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const payload = (await request.json()) as BulkMessagePayload;
	const messageIds = payload.messageIds?.filter(Boolean) ?? [];
	if (messageIds.length === 0 || !isAllowedBulkMessageAction(payload.action)) {
		return NextResponse.json({ error: "Invalid bulk message action" }, { status: 400 });
	}

	try {
		await applyMessageAction(env, user, { messageIds, action: payload.action, folderId: payload.folderId });
	} catch (error) {
		if (error instanceof MessageActionError) {
			return NextResponse.json({ error: error.message }, { status: error.status });
		}
		throw error;
	}
	return NextResponse.json({ ok: true });
}
