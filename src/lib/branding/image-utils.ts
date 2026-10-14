import type { IconDrawRect, InstallIconVariant } from "./types";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Maskable icons may be cropped to a circle 80% of the icon's width (W3C manifest spec, §safe zone). */
export const MASKABLE_SAFE_ZONE = 0.8;

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 24) return null;
	for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
	// The first chunk must be IHDR: length (4), type (4), then width and height.
	if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	return width > 0 && height > 0 ? { width, height } : null;
}

function centered(width: number, height: number, size: number): IconDrawRect {
	const w = Math.max(1, Math.round(width));
	const h = Math.max(1, Math.round(height));
	return { x: Math.round((size - w) / 2), y: Math.round((size - h) / 2), width: w, height: h };
}

/** The largest rectangle with the source's aspect ratio that fits a `size` square, centered. */
export function containRect(sourceWidth: number, sourceHeight: number, size: number): IconDrawRect {
	const scale = size / Math.max(sourceWidth, sourceHeight);
	return centered(sourceWidth * scale, sourceHeight * scale, size);
}

/** The largest rectangle with the source's aspect ratio whose corners stay inside the maskable safe circle. */
export function safeZoneRect(sourceWidth: number, sourceHeight: number, size: number): IconDrawRect {
	const scale = (size * MASKABLE_SAFE_ZONE) / Math.hypot(sourceWidth, sourceHeight);
	return centered(sourceWidth * scale, sourceHeight * scale, size);
}

export function iconDrawRect(variant: InstallIconVariant, sourceWidth: number, sourceHeight: number): IconDrawRect {
	return variant.fit === "safe-zone"
		? safeZoneRect(sourceWidth, sourceHeight, variant.size)
		: containRect(sourceWidth, sourceHeight, variant.size);
}

/**
 * The fill behind an icon that must be opaque: the source's own top-left
 * pixel when it is opaque (so a logo on a coloured square extends to the
 * edges), otherwise white, matching the manifest's background_color.
 */
export function opaqueBackground(corner: ArrayLike<number> | null): string {
	if (!corner || corner.length < 4 || corner[3] < 255) return "#ffffff";
	const hex = (value: number) => value.toString(16).padStart(2, "0");
	return `#${hex(corner[0])}${hex(corner[1])}${hex(corner[2])}`;
}
