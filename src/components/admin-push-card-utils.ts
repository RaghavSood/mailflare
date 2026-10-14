import type { PushStatusResponse } from "./admin-push-card-types";

export async function getPushStatus(): Promise<PushStatusResponse> {
	const response = await fetch("/api/admin/push", { cache: "no-store" });
	const data = (await response.json()) as PushStatusResponse;
	if (!response.ok) throw new Error(data.error ?? "Could not check push notifications");
	return data;
}
