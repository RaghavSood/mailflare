"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { flattenSettingsNavItems, isActiveSettingsPath, settingsNavSections } from "./settings-nav-utils";

const settingsNavItems = flattenSettingsNavItems(settingsNavSections);

export function SettingsNav() {
	const pathname = usePathname();

	return (
		<>
			<nav aria-label="Settings" className="order-first -mb-2 flex gap-2 overflow-x-auto px-4 pt-3 pb-1 [scrollbar-width:none] md:hidden">
				{settingsNavItems.map((item) => {
					const active = isActiveSettingsPath(pathname, item.href);
					return (
						<Link
							key={item.href}
							href={item.href}
							aria-current={active ? "page" : undefined}
							className={cn(
								"flex h-11 shrink-0 items-center whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors",
								active ? "bg-blue-100 text-blue-900" : "bg-white text-neutral-600 hover:text-neutral-900",
							)}
						>
							{item.label}
						</Link>
					);
				})}
			</nav>
			<aside className="min-h-full border-r border-blue-100/70 px-4 py-10 w-64 max-md:hidden">
				<div className="sticky top-6 space-y-7">
					{settingsNavSections.map((section) => (
						<div key={section.label} className="space-y-3">
							<h2 className="px-4 text-xs font-semibold uppercase tracking-wide text-neutral-500">
								{section.label}
							</h2>
							<nav className="space-y-px">
								{section.items.map((item) => {
									const active = isActiveSettingsPath(pathname, item.href);
									return (
										<Link
											key={item.href}
											href={item.href}
											className={cn(
												"block rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
												active
													? "bg-blue-100 text-blue-900"
													: "text-neutral-600 hover:bg-white/70 hover:text-neutral-900",
											)}
										>
											{item.label}
										</Link>
									);
								})}
							</nav>
						</div>
					))}
				</div>
			</aside>
		</>
	);
}
