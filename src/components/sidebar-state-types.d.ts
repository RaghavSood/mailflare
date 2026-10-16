import type { ReactNode } from "react";

export type SidebarState = {
	/** Icon-only rail. Always false below `md`, where the sidebar is a drawer. */
	minimal: boolean;
	toggle(): void;
	/** True below the `md` breakpoint, where the sidebar becomes an off-canvas drawer. */
	compact: boolean;
	drawerOpen: boolean;
	openDrawer(): void;
	closeDrawer(): void;
};

export type SidebarProviderProps = {
	children: ReactNode;
	expandedWidth?: number;
};

export type SidebarHeaderProps = {
	href: string;
	label?: string;
};

export type SidebarDrawerProps = {
	children: ReactNode;
	/** Classes for the aside at `md` and up, where it is the first grid column. */
	className?: string;
};
