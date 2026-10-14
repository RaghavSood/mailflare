"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { SidebarProviderProps, SidebarState } from "./sidebar-state-types";

const SidebarContext = createContext<SidebarState>({
	minimal: false,
	toggle: () => undefined,
	compact: false,
	drawerOpen: false,
	openDrawer: () => undefined,
	closeDrawer: () => undefined,
});

// Tailwind's `md` breakpoint (48rem); below it the sidebar is a drawer.
const COMPACT_QUERY = "(max-width: 47.99rem)";

function subscribeCompact(onChange: () => void) {
	const query = window.matchMedia(COMPACT_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

const getCompact = () => window.matchMedia(COMPACT_QUERY).matches;
// The server renders the desktop shell; CSS already hides the drawer on phones before hydration.
const getServerCompact = () => false;

export function SidebarProvider({ children, expandedWidth = 240 }: SidebarProviderProps) {
	const pathname = usePathname();
	const [minimal, setMinimal] = useState(false);
	const [storageKey, setStorageKey] = useState<string | null>(null);
	const compact = useSyncExternalStore(subscribeCompact, getCompact, getServerCompact);
	const [drawerOpenState, setDrawerOpenState] = useState(false);
	const drawerOpen = compact && drawerOpenState;
	// Any navigation closes the drawer, including browser back/forward and swipe-back,
	// so it never reappears when the user returns to the page it was opened on.
	const [drawerPathname, setDrawerPathname] = useState(pathname);
	if (drawerPathname !== pathname) {
		setDrawerPathname(pathname);
		setDrawerOpenState(false);
	}

	useEffect(() => {
		// The sidebar preference is cosmetic, so every failure here degrades to the default.
		// Guard the parse: an error response may carry an empty or non-JSON body, and an
		// unhandled rejection here surfaces as a confusing SyntaxError overlay in dev.
		void fetch("/api/auth/me", { cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) return null;
				return (await response.json().catch(() => null)) as { user?: { id?: string } } | null;
			})
			.then((data) => {
				const userId = data?.user?.id;
				if (!userId) return;
				const key = `mailflare-sidebar-minimal:${userId}`;
				setStorageKey(key);
				try {
					setMinimal(localStorage.getItem(key) === "true");
				} catch {
					// Storage can be unavailable in private windows; keep the default.
				}
			})
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		if (!drawerOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setDrawerOpenState(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [drawerOpen]);

	function toggle() {
		if (compact) {
			setDrawerOpenState(false);
			return;
		}
		setMinimal((current) => {
			const next = !current;
			if (storageKey) localStorage.setItem(storageKey, String(next));
			return next;
		});
	}

	const state: SidebarState = {
		minimal: minimal && !compact,
		toggle,
		compact,
		drawerOpen,
		openDrawer: () => setDrawerOpenState(true),
		closeDrawer: () => setDrawerOpenState(false),
	};

	return (
		<SidebarContext.Provider value={state}>
			<div className="h-full" style={{ "--sidebar-width": `${minimal ? 72 : expandedWidth}px` } as React.CSSProperties}>
				{children}
			</div>
		</SidebarContext.Provider>
	);
}

export function useSidebar() {
	return useContext(SidebarContext);
}
