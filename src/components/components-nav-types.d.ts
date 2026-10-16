import type { LucideIcon } from "lucide-react";

export type NavLink = {
	href?: string;
	label?: string;
	icon?: LucideIcon;
	iconColor?: string;
	primary?: boolean;
	preloadMessages?: boolean;
	count?: number;
	/** Accessible name for the count badge, e.g. "3 unread" or "2 drafts". */
	countLabel?: string;
	onMessageDrop?: (messageIds: string[]) => void;
};
