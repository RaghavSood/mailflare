import { cx, html, raw, type Html } from "../html";
import { icon } from "../icons";
import type { ComposeDraft } from "../data/compose";
import type { V2Mailbox } from "../types";
import { neutralizeEmailHtml } from "./mail-frame";
import { formatSize } from "./format";

export type ComposerMode = "dock" | "inline" | "page";

const FORMAT_BUTTONS: Array<[string, string, string]> = [
	["bold", "bold", "Bold (⌘B)"],
	["italic", "italic", "Italic (⌘I)"],
	["underline", "underline", "Underline (⌘U)"],
	["insertUnorderedList", "list", "Bulleted list (⌘⇧8)"],
	["insertOrderedList", "list-ordered", "Numbered list (⌘⇧7)"],
	["blockquote", "quote", "Quote (⌘⇧9)"],
	["createLink", "link", "Insert link (⌘K)"],
	["removeFormat", "remove-format", "Remove formatting (⌘\\)"],
];

function fromOptions(mailboxes: V2Mailbox[], draft: ComposeDraft): Html {
	const sendable = mailboxes.filter((mailbox) => mailbox.canSend);
	const selected = `${draft.mailboxId ?? ""}|${draft.from ?? ""}`;
	const options: Html[] = [];
	let found = false;
	for (const mailbox of sendable) {
		const addresses = mailbox.senderAddresses.length ? mailbox.senderAddresses : [mailbox.address];
		for (const address of addresses) {
			const value = `${mailbox.id}|${address}`;
			if (value === selected) found = true;
			options.push(html`<option value="${value}" ${value === selected ? "selected" : ""}>${mailbox.name} &lt;${address}&gt;</option>`);
		}
	}
	// A reply to catch-all mail comes from the address it reached; keep it selectable.
	if (!found && draft.mailboxId && draft.from) {
		options.unshift(html`<option value="${selected}" selected>${draft.from}</option>`);
	}
	const catchAll = sendable.filter((mailbox) => mailbox.catchAllHostnames.length);
	return html`${options}${catchAll.map((mailbox) => html`<option value="${`${mailbox.id}|*`}" data-catch-all="${mailbox.catchAllHostnames.join(",")}">Other address on ${mailbox.catchAllHostnames.join(", ")}…</option>`)}`;
}

/**
 * The composer, used docked (desktop), inline under a conversation, and as a
 * full page (mobile, drafts, new tab). Drafts save in the background; the
 * form itself only submits to send.
 */
export function renderComposer(
	draft: ComposeDraft,
	input: { mailboxes: V2Mailbox[]; mode: ComposerMode; key: string; returnHref: string; title?: string },
): Html {
	const showCc = !!draft.cc;
	const showBcc = !!draft.bcc;
	const title = input.title ?? (draft.subject || (draft.inReplyTo ? "Reply" : "New message"));
	return html`<form class="${cx("composer", `composer-${input.mode}`)}" id="${`composer-${input.key}`}" data-composer data-mode="${input.mode}" method="post" action="/v2/send" enctype="multipart/form-data" autocomplete="off">
		<input type="hidden" name="draftId" value="${draft.id ?? ""}" data-draft-id>
		<input type="hidden" name="inReplyTo" value="${draft.inReplyTo ?? ""}">
		<input type="hidden" name="references" value="${draft.references ?? ""}">
		<input type="hidden" name="threadId" value="${draft.threadId ?? ""}">
		<input type="hidden" name="html" value="" data-html>
		<input type="hidden" name="return" value="${input.returnHref}" data-return>
		${input.mode !== "inline" ? html`<div class="cmp-head">
			<span class="cmp-title" data-cmp-title>${title}</span>
			<span class="cmp-state" data-cmp-state aria-live="polite"></span>
			${input.mode === "dock" ? html`<button type="button" class="icon-button" data-cmp-minimize aria-label="Minimize">${icon("minus")}</button>` : ""}
			<button type="button" class="icon-button" data-cmp-close aria-label="Save and close" title="Save and close (Esc)">${icon("x")}</button>
		</div>` : html`<div class="cmp-head is-inline"><span class="cmp-title">${draft.subject}</span><span class="cmp-state" data-cmp-state aria-live="polite"></span><button type="button" class="icon-button" data-cmp-close aria-label="Save and close">${icon("x")}</button></div>`}
		<div class="cmp-fields">
			<div class="cmp-field">
				<label for="${`from-${input.key}`}">From</label>
				<select id="${`from-${input.key}`}" name="from" data-cmp-from>${fromOptions(input.mailboxes, draft)}</select>
				<input type="email" class="cmp-custom-from" name="customFrom" placeholder="name@example.com" data-cmp-custom-from hidden aria-label="Send from address">
			</div>
			<div class="cmp-field">
				<label for="${`to-${input.key}`}">To</label>
				<input id="${`to-${input.key}`}" name="to" value="${draft.to}" data-recipients list="v2-contacts" autocomplete="off" required>
				<span class="cmp-toggles">
					<button type="button" class="link-button" data-cmp-show="cc" ${showCc ? "hidden" : ""}>Cc</button>
					<button type="button" class="link-button" data-cmp-show="bcc" ${showBcc ? "hidden" : ""}>Bcc</button>
				</span>
			</div>
			<div class="cmp-field" data-cmp-row="cc" ${showCc ? "" : "hidden"}>
				<label for="${`cc-${input.key}`}">Cc</label>
				<input id="${`cc-${input.key}`}" name="cc" value="${draft.cc}" data-recipients list="v2-contacts" autocomplete="off">
			</div>
			<div class="cmp-field" data-cmp-row="bcc" ${showBcc ? "" : "hidden"}>
				<label for="${`bcc-${input.key}`}">Bcc</label>
				<input id="${`bcc-${input.key}`}" name="bcc" value="${draft.bcc}" data-recipients list="v2-contacts" autocomplete="off">
			</div>
			<div class="cmp-field">
				<input name="subject" value="${draft.subject}" placeholder="Subject" aria-label="Subject" data-cmp-subject>
			</div>
		</div>
		<div class="cmp-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message body" data-editor>${raw(neutralizeEmailHtml(draft.bodyHtml))}</div>
		${draft.quoteHtml ? html`<div class="cmp-quote" title="The quoted message is sent below your reply">${icon("quote")}<span>${draft.inReplyTo ? "Quoted text" : "Forwarded message"} included</span></div>` : ""}
		<div class="cmp-files" data-cmp-files>
			${draft.attachments.map((file) => html`<span class="file-chip" data-stored-attachment="${file.id}">${icon("paperclip")}<span>${file.filename}</span><small>${formatSize(file.size)}</small><button type="button" class="icon-button" data-remove-attachment="${file.id}" aria-label="${`Remove ${file.filename}`}">${icon("x")}</button></span>`)}
		</div>
		<div class="cmp-foot">
			<button type="submit" class="button button-primary" data-cmp-send title="Send (⌘Enter)">${icon("send")}<span>Send</span></button>
			<label class="icon-button" title="Attach files" aria-label="Attach files">${icon("paperclip")}<input type="file" name="attachments" multiple hidden data-cmp-attach></label>
			<div class="cmp-format" role="toolbar" aria-label="Formatting">
				${FORMAT_BUTTONS.map(([command, iconName, label]) => html`<button type="button" class="icon-button" data-format="${command}" title="${label}" aria-label="${label}">${icon(iconName)}</button>`)}
			</div>
			<span class="tb-spacer"></span>
			<button type="button" class="icon-button" data-cmp-discard title="Discard draft" aria-label="Discard draft">${icon("trash")}</button>
		</div>
	</form>`;
}

/** Composer markup inside the dock container, for the out-of-band dock swap. */
export function renderDock(content: Html | null): Html {
	return html`<div id="compose-dock" class="compose-dock">${content ?? ""}</div>`;
}

export function renderComposePageMain(composer: Html): Html {
	return html`<main id="main" class="main" hx-history-elt>
		<div class="page" data-page="compose">${composer}</div>
	</main>`;
}
