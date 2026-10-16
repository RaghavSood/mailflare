import { NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth/admin";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { countPushSubscriptions } from "@/lib/push/delivery";
import { describePushConfig } from "@/lib/push/push-utils";

/** Whether Web Push is configured, and how many devices are subscribed. Never returns the keys. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	try {
		assertAdmin(auth.user);
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
	const { configured, problems } = describePushConfig(env);
	// Before migration 0036 is applied the table does not exist yet.
	const subscriptions = await countPushSubscriptions(env).catch(() => null);
	return NextResponse.json({ configured, problems, subscriptions });
}
