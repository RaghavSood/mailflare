import type { SettingsNavItem, SettingsNavSection } from "./settings-nav-types";

export const settingsNavSections: SettingsNavSection[] = [
	{
		label: "Settings",
		items: [
			{
				href: "/settings/account",
				label: "Account",
			},
			{
				href: "/settings/inbox",
				label: "Inbox",
			},
			{
				href: "/settings/rules",
				label: "Rules & Routing",
			},
		],
	},
	{
		label: "Mailbox",
		items: [
			{
				href: "/settings/import",
				label: "Import",
			},
			{
				href: "/settings/export",
				label: "Export",
			},
		],
	},
];

export function isActiveSettingsPath(pathname: string, href: string): boolean {
	return pathname === href || pathname.startsWith(`${href}/`);
}

/** Every link in section order, for the single tab strip shown on narrow screens. */
export function flattenSettingsNavItems(sections: SettingsNavSection[]): SettingsNavItem[] {
	return sections.flatMap((section) => section.items);
}
