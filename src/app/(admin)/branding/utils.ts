import { authFetch } from "@/lib/auth/client";
import { INSTALL_ICON_VARIANTS } from "@/lib/branding/install-utils";
import type { BrandingFormResponse, InstallIconBlobs } from "./types";

export const BRANDING_ICON_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export async function saveBranding(appName: string, icon: File | null, installIcons: InstallIconBlobs | null = null): Promise<BrandingFormResponse> {
	const form = new FormData();
	form.set("appName", appName);
	if (icon) form.set("icon", icon, icon.name);
	for (const variant of INSTALL_ICON_VARIANTS) {
		const blob = installIcons?.[variant.field];
		if (blob) form.set(variant.field, blob, `icon-${variant.id}.png`);
	}
	const response = await authFetch("/api/branding", { method: "PUT", body: form });
	const data = (await response.json()) as BrandingFormResponse;
	if (!response.ok) throw new Error(data.error ?? "Unable to save branding");
	return data;
}
