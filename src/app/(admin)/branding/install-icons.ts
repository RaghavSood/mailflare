import { iconDrawRect, opaqueBackground } from "@/lib/branding/image-utils";
import { INSTALL_ICON_VARIANTS } from "@/lib/branding/install-utils";
import type { InstallIconVariant } from "@/lib/branding/types";
import type { InstallIconBlobs } from "./types";

function canvasOf(size: number): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	return canvas;
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not render the install icons"))), "image/png");
	});
}

/** The source's top-left pixel, to extend an opaque logo's own background. */
function cornerPixel(image: ImageBitmap): Uint8ClampedArray | null {
	const context = canvasOf(1).getContext("2d");
	if (!context) return null;
	context.drawImage(image, 0, 0, 1, 1, 0, 0, 1, 1);
	return context.getImageData(0, 0, 1, 1).data;
}

function drawVariant(image: ImageBitmap, variant: InstallIconVariant, background: string): Promise<Blob> {
	const canvas = canvasOf(variant.size);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("This browser cannot render the install icons");
	if (variant.fit !== "contain") {
		context.fillStyle = background;
		context.fillRect(0, 0, variant.size, variant.size);
	}
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = "high";
	const rect = iconDrawRect(variant, image.width, image.height);
	context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
	return toPng(canvas);
}

/**
 * Renders the install icons (192, 512, maskable 512, apple-touch 180) from an
 * uploaded icon of any size. This happens here because neither Workers nor
 * the self-hosted runtime can resize images; the server checks each PNG's
 * dimensions instead.
 */
export async function renderInstallIcons(file: File): Promise<InstallIconBlobs> {
	let image: ImageBitmap;
	try {
		image = await createImageBitmap(file);
	} catch {
		throw new Error("Could not read that image");
	}
	try {
		const background = opaqueBackground(cornerPixel(image));
		const icons: InstallIconBlobs = {};
		for (const variant of INSTALL_ICON_VARIANTS) icons[variant.field] = await drawVariant(image, variant, background);
		return icons;
	} finally {
		image.close();
	}
}
