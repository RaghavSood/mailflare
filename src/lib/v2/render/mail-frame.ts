import { escapeHtml } from "../html";

/**
 * Email HTML is shown in an iframe sandboxed without scripts, forms or
 * top-level navigation, with its own CSP. Before that, tags that could take
 * over the frame are made inert. Void tags (no closing tag) are removed: a
 * renamed void tag would become an ordinary element and swallow everything
 * after it. Container tags are renamed so their closing tags still match.
 */
const REMOVED_VOID_TAGS = ["meta", "base", "embed", "frame"];
const RENAMED_TAGS = ["script", "iframe", "frameset", "object", "applet", "form", "noscript", "template", "portal"];
// A tag with attributes, quoted values allowed to contain ">".
const VOID_PATTERN = new RegExp(`<(?:${REMOVED_VOID_TAGS.join("|")})(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
const RENAMED_PATTERN = new RegExp(`<(/?)(${RENAMED_TAGS.join("|")})(?=[\\s/>])`, "gi");

export function neutralizeEmailHtml(value: string): string {
	return value.replace(VOID_PATTERN, "").replace(RENAMED_PATTERN, "<$1x-blocked-$2");
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
x-blocked-script,x-blocked-iframe,x-blocked-frameset,x-blocked-object,x-blocked-applet,x-blocked-noscript,x-blocked-template,x-blocked-portal{display:none!important}
x-blocked-form{display:contents}
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
