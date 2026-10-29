export type AttachmentViewerKind = "pdf" | "image";

/** Image types every current browser draws in an <img>; SVG is left out because it can carry script. */
const VIEWABLE_IMAGES = new Set(["image/png", "image/jpeg", "image/jpg", "image/pjpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);

const GENERIC_TYPES = new Set(["application/octet-stream", "application/x-download", "application/download", "binary/octet-stream"]);

function baseType(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

/**
 * The type an attachment is served as for previewing. Some senders label
 * PDFs application/octet-stream, so a generic type falls back to the name.
 */
export function previewContentType(contentType: string, filename: string): string {
	const type = baseType(contentType);
	if (GENERIC_TYPES.has(type) && /\.pdf$/i.test(filename.trim())) return "application/pdf";
	return type;
}

/** Whether the v2 reader opens this attachment in its viewer, and as what. */
export function attachmentViewerKind(contentType: string, filename: string): AttachmentViewerKind | null {
	const type = previewContentType(contentType, filename);
	if (type === "application/pdf") return "pdf";
	if (VIEWABLE_IMAGES.has(type)) return "image";
	return null;
}
