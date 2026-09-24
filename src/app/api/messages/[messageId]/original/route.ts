import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMessageOriginalForUser } from "@/lib/email/message-headers";
import type { MessageOriginalRouteParams } from "./types";

/**
 * The message exactly as received. Served as text/plain so the browser shows it
 * instead of handing it to a mail client; `?download=1` saves it as .eml.
 */
export async function GET(request: Request, { params }: MessageOriginalRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return new Response("Unauthorized", { status: 401 });

	const { messageId } = await params;
	const result = await getMessageOriginalForUser(env, user, messageId);
	if (!result) return new Response("Not found", { status: 404 });

	const download = new URL(request.url).searchParams.get("download") === "1";
	const headers = new Headers();
	headers.set("Content-Type", download ? "message/rfc822" : "text/plain; charset=utf-8");
	headers.set("Content-Length", String(result.object.size));
	headers.set(
		"Content-Disposition",
		download ? `attachment; filename="${messageId}.eml"` : "inline",
	);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
	headers.set("Cache-Control", "private, max-age=3600");
	return new Response(result.object.body, { headers });
}
