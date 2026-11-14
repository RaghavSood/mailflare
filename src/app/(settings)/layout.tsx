import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { SettingsShell } from "@/components/settings/settings-shell";
import { UI_PREFERENCE_COOKIE } from "@/lib/v2/preference";

export default async function SettingsGroupLayout({ children }: { children: ReactNode }) {
	const cookieStore = await cookies();
	return <SettingsShell uiPreference={cookieStore.get(UI_PREFERENCE_COOKIE)?.value}>{children}</SettingsShell>;
}
