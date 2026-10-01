import { escapeHtml } from "../html";

/**
 * Email HTML is shown in an iframe sandboxed without scripts, forms or
 * top-level navigation, with its own CSP. These tags are also neutralised
 * first (renamed to inert elements and hidden) so a refresh, base URL or
 * embedded document cannot take over the frame.
 */
const BLOCKED_TAGS = ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "meta", "base", "link", "noscript", "template", "portal"];
const BLOCKED_PATTERN = new RegExp(`<(/?)(${BLOCKED_TAGS.join("|")})(?=[\\s/>])`, "gi");

export function neutralizeEmailHtml(value: string): string {
	return value.replace(BLOCKED_PATTERN, "<$1x-blocked-$2");
}

/** Inline images reference attachments by Content-ID; point them at the stored files. */
export function resolveContentIds(
	value: string,
	messageId: string,
	attachments: Array<{ id: string; contentId: string | null }>,
): string {
	return attachments.reduce((html, attachment) => {
		if (!attachment.contentId) return html;
		const contentId = attachment.contentId.replace(/^<|>$/g, "");
		return html.split(`cid:${contentId}`).join(`/api/messages/${messageId}/attachments/${attachment.id}`);
	}, value);
}

const FRAME_CSP = [
	"default-src 'none'",
	"img-src https: http: data: blob:",
	"style-src 'unsafe-inline' https: http:",
	"font-src https: http: data:",
	"media-src https: http: data:",
].join("; ");

const FRAME_STYLE = `
html,body{margin:0;padding:0;background:#fff;color:#1f1f1f}
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere;padding:2px}
img{max-width:100%;height:auto}
table{max-width:100%}
pre{white-space:pre-wrap}
a{color:#1a5fd0}
[class^="x-blocked-"],x-blocked-script,x-blocked-iframe,x-blocked-frame,x-blocked-frameset,x-blocked-object,x-blocked-embed,x-blocked-applet,x-blocked-form,x-blocked-meta,x-blocked-base,x-blocked-link,x-blocked-noscript,x-blocked-template,x-blocked-portal{display:none!important}
.mf-quote-hidden{display:none!important}
`;

/** A complete document for an email iframe's srcdoc. */
export function buildMailFrameDocument(bodyHtml: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>${FRAME_STYLE}</style></head><body>${neutralizeEmailHtml(bodyHtml)}</body></html>`;
}

const URL_PATTERN = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** Plain-text mail as escaped HTML with web links made clickable. */
export function plainTextToHtml(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split(URL_PATTERN)
		.map((part, index) =>
			index % 2 === 1
				? `<a href="${escapeHtml(part)}" target="_blank" rel="noopener noreferrer">${escapeHtml(part)}</a>`
				: escapeHtml(part))
		.join("");
}
