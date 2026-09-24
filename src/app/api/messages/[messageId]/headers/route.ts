import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMessageHeaderDetailsForUser } from "@/lib/email/message-headers";
import type { MessageHeadersRouteParams } from "./types";

export async function GET(request: Request, { params }: MessageHeadersRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const { messageId } = await params;
	const result = await getMessageHeaderDetailsForUser(env, user, messageId);
	if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
	return NextResponse.json(result);
}
