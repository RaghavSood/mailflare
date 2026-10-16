import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import { getFolderBadgeCount, getFolderBadgeLabel } from "@/app/api/messages/counts/utils";
import type { MessageCounts, MessageFolder } from "@/hooks/types";
import { authFetch } from "@/lib/auth/client";
import type { NavLink } from "./components-nav-types";

export function getFolderNavBadge(
	folder: MessageFolder,
	counts: MessageCounts["folders"],
): Pick<NavLink, "count" | "countLabel"> {
	const count = getFolderBadgeCount(folder, counts);
	return { count, countLabel: getFolderBadgeLabel(folder, count) };
}

async function moveMessages(payload: { messageIds: string[]; action: BulkMessageAction; folderId?: string }) {
	const response = await authFetch("/api/messages/bulk", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!response.ok) throw new Error("Unable to move messages");
	window.dispatchEvent(new Event("mailflare:messages-changed"));
}

export function moveMessagesToSystemFolder(messageIds: string[], action: "archive" | "spam" | "trash") {
	return moveMessages({ messageIds, action });
}

export function moveMessagesToCustomFolder(messageIds: string[], folderId: string) {
	return moveMessages({ messageIds, action: "folder", folderId });
}
