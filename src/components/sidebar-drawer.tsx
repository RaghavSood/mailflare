"use client";

import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebar } from "./sidebar-state";
import type { SidebarDrawerProps } from "./sidebar-state-types";

/**
 * The shell's sidebar column. From `md` up it is the first grid column, exactly as before;
 * below `md` it is an off-canvas drawer opened by `SidebarMenuButton`.
 */
export function SidebarDrawer({ children, className }: SidebarDrawerProps) {
	const { compact, drawerOpen, closeDrawer } = useSidebar();
	const hidden = compact && !drawerOpen;

	return (
		<>
			<div
				aria-hidden="true"
				onClick={closeDrawer}
				className={cn(
					"fixed inset-0 z-40 bg-black/35 transition-opacity duration-200 md:hidden",
					drawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
				)}
			/>
			<aside
				id="app-sidebar"
				inert={hidden}
				// A link to the page already open does not change the path, so close on the tap itself.
				onClick={(event) => {
					if (drawerOpen && (event.target as HTMLElement).closest("a")) closeDrawer();
				}}
				className={cn(
					"fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] bg-[#f6f8fc] shadow-xl transition-transform duration-200 md:static md:z-auto md:w-auto md:max-w-none md:translate-x-0 md:shadow-none md:transition-none",
					drawerOpen ? "translate-x-0" : "-translate-x-full",
					className,
				)}
			>
				{children}
			</aside>
		</>
	);
}

export function SidebarMenuButton({ className }: { className?: string }) {
	const { drawerOpen, openDrawer } = useSidebar();

	return (
		<button
			type="button"
			onClick={openDrawer}
			aria-label="Open menu"
			aria-controls="app-sidebar"
			aria-expanded={drawerOpen}
			className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200 md:hidden", className)}
		>
			<Menu className="h-5 w-5" />
		</button>
	);
}
