import { readPngDimensions } from "@/lib/branding/image-utils";
import { INSTALL_ICON_VARIANTS } from "@/lib/branding/install-utils";
import type { InstallIconUploads } from "@/lib/branding/types";
import type { UploadedBrandingIcon } from "./types";

export const MAX_BRANDING_ICON_SIZE = 2 * 1024 * 1024;
export const BRANDING_ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function isBrandingIcon(value: FormDataEntryValue | null): value is UploadedBrandingIcon {
	return value !== null && typeof value !== "string" && typeof value.arrayBuffer === "function";
}

/**
 * The resized install icons that accompany a new icon: all of them or none
 * (an API client that sends only the original keeps the packaged install
 * icons). Each must be a PNG of exactly its variant's size, which the PNG
 * header states without decoding the image.
 */
export async function validateInstallIcons(
	form: Pick<FormData, "get">,
): Promise<{ icons: InstallIconUploads | null } | { error: string }> {
	const files = INSTALL_ICON_VARIANTS.map((variant) => {
		const value = form.get(variant.field);
		return { variant, file: isBrandingIcon(value) && value.size > 0 ? value : null };
	});
	const present = files.filter((entry) => entry.file);
	if (present.length === 0) return { icons: null };
	if (present.length !== files.length) return { error: "Upload every install icon size or none" };
	const icons: InstallIconUploads = {};
	for (const { variant, file } of files) {
		if (!file) continue;
		if (file.size > MAX_BRANDING_ICON_SIZE) return { error: "Install icons must be 2 MB or smaller" };
		const dimensions = readPngDimensions(new Uint8Array(await file.slice(0, 24).arrayBuffer()));
		if (!dimensions || dimensions.width !== variant.size || dimensions.height !== variant.size) {
			return { error: `The ${variant.id} install icon must be a ${variant.size}x${variant.size} PNG` };
		}
		icons[variant.field] = file;
	}
	return { icons };
}
