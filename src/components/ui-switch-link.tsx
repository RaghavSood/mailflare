"use client";

import { usePathname } from "next/navigation";
import { Sparkles } from "lucide-react";

/**
 * Opens the same page in the v2 interface. A plain link (not client routing):
 * /v2 is server-rendered, and the switch remembers the choice for next login.
 */
export function UiSwitchLink() {
	const pathname = usePathname();
	return (
		<a
			href={`/v2/switch?to=v2&from=${encodeURIComponent(pathname)}`}
			className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-neutral-300 px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
			title="Switch to the new interface"
		>
			<Sparkles className="h-4 w-4" />
			<span>New UI</span>
		</a>
	);
}
