"use client";

import { usePathname, useRouter } from "next/navigation";
import { getMessageListHref, isMoveMessageAction } from "@/components/message-actions/utils";
import { useState } from "react";
import { BulkMessageSelectionPane } from "./bulk-message-selection-pane";
import { MessageFolderPage } from "./message-folder-page";
import type { MessageSplitLayoutProps, SelectedMessage } from "./types";

export function MessageSplitLayout({
	children,
	config,
}: MessageSplitLayoutProps) {
	const pathname = usePathname();
	const router = useRouter();
	const [selectedMessages, setSelectedMessages] = useState<SelectedMessage[]>([]);
	const detailPrefix = `${config.hrefPrefix}/`;
	const selectedMessageId = pathname.startsWith(detailPrefix)
		? pathname.slice(detailPrefix.length).split("/")[0]
		: undefined;

	if (!selectedMessageId) return children;

	return (
		<div className="h-full min-h-0 overflow-hidden lg:grid lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
			<aside className="hidden min-h-0 overflow-hidden border-r border-neutral-200 bg-white lg:block">
				<MessageFolderPage
					config={config}
					compact
					selectedMessageId={selectedMessageId}
					selection={{ selectedMessages, setSelectedMessages }}
				/>
			</aside>
			<section className="min-h-0 min-w-0 overflow-hidden bg-white">
				{selectedMessages.length > 0 ? (
					<BulkMessageSelectionPane
						selectedMessages={selectedMessages}
						onClearSelection={() => setSelectedMessages([])}
						onActionComplete={(action, messageIds) => {
							// The open message went with the selection: back to the list.
							if (!isMoveMessageAction(action) || !messageIds.includes(selectedMessageId)) return;
							const listHref = getMessageListHref(pathname, selectedMessageId);
							if (listHref) router.replace(listHref);
						}}
					/>
				) : (
					children
				)}
			</section>
		</div>
	);
}
