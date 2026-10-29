import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getAttachmentForUser } from "@/lib/email/attachments";
import { previewContentType } from "@/lib/email/attachment-preview-utils";
import type { AttachmentRouteParams } from "./types";
import {
	getAttachmentContentDisposition,
	isPreviewableAttachmentType,
} from "./utils";

export async function GET(request: Request, { params }: AttachmentRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return new Response("Unauthorized", { status: 401 });

	const { attachmentId, messageId } = await params;
	const result = await getAttachmentForUser(env, user, messageId, attachmentId);
	if (!result) return new Response("Not found", { status: 404 });

	const { attachment, object } = result;
	const url = new URL(request.url);
	const previewRequested = url.searchParams.get("preview") === "1";
	const downloadRequested = url.searchParams.get("download") === "1";
	// A preview of a PDF labelled application/octet-stream is served as a PDF so the browser draws it.
	const contentType = previewRequested
		? previewContentType(attachment.contentType, attachment.filename)
		: attachment.contentType;
	const inline =
		!downloadRequested &&
		(attachment.disposition === "inline" ||
			(previewRequested && isPreviewableAttachmentType(contentType)));
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("Content-Type", contentType);
	headers.set("Content-Length", String(attachment.size));
	headers.set("Content-Disposition", getAttachmentContentDisposition(attachment.filename, inline));
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set(
		"Content-Security-Policy",
		"default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; sandbox",
	);
	headers.set("Cache-Control", "private, max-age=3600");

	return new Response(object.body, { headers });
}
