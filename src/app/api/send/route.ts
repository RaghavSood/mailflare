import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { sendEmailSchema } from "@/lib/validators";
import { sendEmail } from "@/lib/email/send";
import { parseSendRequest } from "./utils";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getSendErrorStatus } from "./error-utils";
import { getDb } from "@/db";
import { loadMessageAttachmentContents } from "@/lib/email/attachments";
import { claimDraftForSend, releaseDraftClaim } from "@/lib/email/draft-claim";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let input;
	try {
		input = await parseSendRequest(request);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid send request" }, { status });
	}
	const { attachments = [], draftId, ...fields } = input;
	const parsed = sendEmailSchema.omit({ attachments: true }).safeParse(fields);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	// Files already stored on the draft (a forwarded message's attachments) ride
	// along with whatever the composer uploaded in this request. Claiming the
	// draft first means a second request for it cannot send it again while this
	// one is in flight; the composer deletes the draft once this returns.
	const db = getDb(env);
	const claim = draftId ? await claimDraftForSend(db, user.id, draftId) : null;
	if (claim?.outcome === "gone") {
		return NextResponse.json({ error: "Draft not found" }, { status: 404 });
	}
	if (claim?.outcome === "sending") {
		return NextResponse.json({ error: "This message is already being sent." }, { status: 409 });
	}

	try {
		if (claim?.outcome === "claimed") attachments.push(...(await loadMessageAttachmentContents(env, claim.draft.id)));
		const result = await sendEmail(env, {
			userId: user.id,
			...parsed.data,
			attachments,
		});
		return NextResponse.json(result);
	} catch (err) {
		if (claim?.outcome === "claimed") await releaseDraftClaim(db, claim.draft.id, claim.claimedAt);
		const message = err instanceof Error ? err.message : "Send failed";
		return NextResponse.json({ error: message }, { status: getSendErrorStatus(message) });
	}
}
