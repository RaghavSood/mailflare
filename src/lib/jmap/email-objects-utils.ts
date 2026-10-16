/**
 * Properties built from the stored text and HTML bodies. `bodyStructure`,
 * `textBody` and `htmlBody` carry each part's own byte size, which the stored
 * `body_size` (their sum) cannot give, so they read the bodies too.
 */
const BODY_PROPERTIES = new Set(["bodyStructure", "textBody", "htmlBody"]);

/** Properties built from attachment rows. */
const ATTACHMENT_PROPERTIES = new Set(["size", "hasAttachment", "attachments", "bodyStructure"]);

/** D1 binds at most 100 parameters per statement. */
export const D1_MAX_PARAMETERS = 100;

/**
 * Whether an Email/get must load `text_body` and `html_body`. `properties`
 * null or absent means every property (RFC 8621 §4.2), which includes the
 * bodies. `bodyValues` is empty unless a fetch*BodyValues flag is set, so on
 * its own it needs nothing. `size` and `preview` are answered from
 * `body_size` and `snippet` without them.
 */
export function emailNeedsBodies(properties: readonly string[] | null | undefined, fetchBodyValues: boolean): boolean {
	if (!properties) return true;
	return properties.some((property) => BODY_PROPERTIES.has(property) || (property === "bodyValues" && fetchBodyValues));
}

/** Whether an Email/get must load attachment rows. */
export function emailNeedsAttachments(properties: readonly string[] | null | undefined): boolean {
	if (!properties) return true;
	return properties.some((property) => ATTACHMENT_PROPERTIES.has(property));
}

/**
 * Split ids into IN lists that fit D1's parameter limit beside the
 * `fixedParameters` the rest of the statement binds.
 */
export function chunkForParameters<T>(items: readonly T[], fixedParameters: number): T[][] {
	const size = Math.max(D1_MAX_PARAMETERS - fixedParameters, 1);
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
}
