import { getHiddenEnvelopeRecipient, summarizeAuthentication, formatAuthenticationCheck, formatTransportSecurity } from "@/components/messages/message-header-details-utils";
import type { MessageHeaderDetails } from "@/lib/email/header-types";
import { splitEmailAddressList } from "@/lib/email/address";
import { cx, html, raw, type Html } from "../html";
import { icon } from "../icons";
import type { V2Context, V2Folder, V2Thread, V2ThreadMessage, V2ViewKey } from "../types";
import { avatarHue, bareAddress, displayName, formatCount, formatFullDate, formatRelative, formatSize, initials, recipientSummary } from "./format";
import { buildMailFrameDocument, plainTextToHtml, resolveContentIds } from "./mail-frame";
import { moveMenu, snoozeMenu } from "./menus";

export type ThreadPageInput = {
	view: V2ViewKey;
	folderId: string | null;
	q: string;
	thread: V2Thread;
	listHref: string;
	index: number | null;
	total: number | null;
	newerHref: string | null;
	olderHref: string | null;
	folders: V2Folder[];
	timeZone: string;
	ownAddresses: Set<string>;
	/** Messages to show open: the newest and any that were unread. */
	expandedIds: Set<string>;
	replySlot?: Html | null;
};

const STATUS_LABELS: Record<string, string> = { received: "Inbox", archived: "Archive", spam: "Spam", trash: "Trash", sent: "Sent", queued: "Scheduled" };

/** Plain-text bodies fold everything from the first "On … wrote:" line, like quoted HTML. */
function renderTextBody(text: string): Html {
	const match = text.match(/^(?:On .{4,200}wrote:|-{2,}\s*Original Message\s*-{2,}|-{5,} ?Forwarded message ?-{5,})\s*$/m);
	if (!match || match.index === undefined || match.index < 1) {
		return html`<div class="mail-text">${raw(plainTextToHtml(text))}</div>`;
	}
	const latest = text.slice(0, match.index).trimEnd();
	const quoted = text.slice(match.index);
	return html`<div class="mail-text">${raw(plainTextToHtml(latest))}</div>
		<details class="quote-fold"><summary aria-label="Show trimmed content" title="Show trimmed content">•••</summary><div class="mail-text is-quote">${raw(plainTextToHtml(quoted))}</div></details>`;
}

export function renderMessageBody(message: V2ThreadMessage): Html {
	const files = message.attachments.filter((item) => item.disposition === "attachment" || !item.contentId);
	const body = message.htmlBody
		? html`<iframe class="mail-frame" title="Message body" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${buildMailFrameDocument(resolveContentIds(message.htmlBody, message.id, message.attachments))}"></iframe>`
		: renderTextBody(message.textBody ?? message.snippet ?? "");
	return html`<div class="msg-content" id="${`body-${message.id}`}">
		${body}
		${files.length ? html`<div class="attachments">${files.map((file) => html`
			<a class="attachment" href="${`/api/messages/${message.id}/attachments/${file.id}?download=1`}" hx-boost="false" download="${file.filename}">
				<span class="attachment-icon">${icon("paperclip")}</span>
				<span class="attachment-name">${file.filename}</span>
				<span class="attachment-size">${formatSize(file.size)}</span>
				<span class="attachment-action" aria-hidden="true">${icon("download")}</span>
			</a>`)}</div>` : ""}
	</div>`;
}

function renderMessage(message: V2ThreadMessage, input: ThreadPageInput, expanded: boolean, isLast: boolean): Html {
	const name = message.direction === "outbound" ? "me" : displayName(message.fromAddr, message.fromName);
	const fullName = message.direction === "outbound" ? displayName(message.fromAddr, message.fromName) : name;
	const address = bareAddress(message.fromAddr);
	const to = recipientSummary(message.toAddr, input.ownAddresses);
	const cc = recipientSummary(message.ccAddr, input.ownAddresses);
	const hidden = getHiddenEnvelopeRecipient({
		id: message.id,
		direction: message.direction,
		fromAddr: message.fromAddr,
		toAddr: message.toAddr,
		ccAddr: message.ccAddr,
		bccAddr: message.bccAddr,
		subject: message.subject,
		createdAt: message.createdAt.toISOString(),
		deliveredTo: message.deliveredTo,
	});
	const unread = message.direction === "inbound" && !message.read;
	return html`<section class="${cx("msg", expanded ? "is-expanded" : "is-collapsed", unread && "is-unread", isLast && "is-last")}" id="${`m-${message.id}`}" data-msg data-id="${message.id}">
		<div class="msg-head" data-msg-toggle tabindex="-1">
			<span class="avatar" style="${`--hue:${avatarHue(address)}`}" aria-hidden="true">${initials(fullName)}</span>
			<div class="msg-who">
				<div class="msg-from"><span class="msg-name">${fullName}</span><span class="msg-address">${address}</span></div>
				<div class="msg-summary">${message.snippet ?? ""}</div>
				<div class="msg-recipients">
					${to ? html`to ${to}` : html`to undisclosed recipients`}${cc ? html`, cc ${cc}` : ""}
					${hidden ? html` <span class="via" title="Delivered to this address; it is not listed in To or Cc">via ${hidden}</span>` : ""}
					<button type="button" class="link-button details-toggle" data-details="${message.id}" hx-get="${`/v2/headers/${message.id}`}" hx-target="${`#details-${message.id}`}" hx-select="${`#details-${message.id}`}" hx-swap="outerHTML" hx-push-url="false" hx-trigger="click once" aria-label="Show details">${icon("chevron-down")}</button>
				</div>
			</div>
			<div class="msg-when">
				${message.attachments.some((item) => item.disposition === "attachment") ? html`<span class="msg-clip">${icon("paperclip")}</span>` : ""}
				<time datetime="${message.createdAt.toISOString()}" title="${formatFullDate(message.createdAt, input.timeZone)}">${formatFullDate(message.createdAt, input.timeZone)}<span class="msg-relative"> (${formatRelative(message.createdAt)})</span></time>
				<div class="msg-actions">
					<form class="inline-form" hx-post="/v2/reply" hx-target="#reply-slot" hx-select="#reply-slot" hx-swap="outerHTML" hx-push-url="false">
						<input type="hidden" name="messageId" value="${message.id}">
						<button class="icon-button" name="mode" value="reply" title="Reply (r)" aria-label="Reply">${icon("reply")}</button>
					</form>
					<details class="menu" data-menu="message">
						<summary class="icon-button" title="More" aria-label="More">${icon("more")}</summary>
						<div class="menu-panel menu-right" role="menu">
							<form hx-post="/v2/reply" hx-target="#reply-slot" hx-select="#reply-slot" hx-swap="outerHTML" hx-push-url="false">
								<input type="hidden" name="messageId" value="${message.id}">
								<button class="menu-item" name="mode" value="reply" role="menuitem">${icon("reply")}Reply</button>
								<button class="menu-item" name="mode" value="all" role="menuitem">${icon("reply-all")}Reply all</button>
								<button class="menu-item" name="mode" value="forward" role="menuitem">${icon("forward")}Forward</button>
							</form>
							<form method="post" action="/v2/unread-from">
								<input type="hidden" name="messageId" value="${message.id}">
								<input type="hidden" name="return" value="${input.listHref}">
								<button class="menu-item" role="menuitem">${icon("mail")}Mark unread from here</button>
							</form>
							<div class="menu-sep"></div>
							<a class="menu-item" href="${`/api/messages/${message.id}/original`}" target="_blank" rel="noopener" hx-boost="false" role="menuitem">${icon("external-link")}Show original</a>
							<a class="menu-item" href="${`/api/messages/${message.id}/original?download=1`}" hx-boost="false" role="menuitem">${icon("download")}Download message</a>
						</div>
					</details>
				</div>
			</div>
		</div>
		<div class="msg-body">
			<div class="msg-details" id="${`details-${message.id}`}" hidden></div>
			${expanded
				? renderMessageBody(message)
				: html`<div class="msg-content msg-lazy" id="${`body-${message.id}`}" hx-get="${`/v2/body/${message.id}`}" hx-trigger="msg-expand once" hx-target="this" hx-select="${`#body-${message.id}`}" hx-swap="outerHTML" hx-push-url="false"><span class="loading">Loading…</span></div>`}
		</div>
	</section>`;
}

export function renderReplyButtons(messageId: string): Html {
	return html`<div id="reply-slot" class="reply-slot">
		<form class="reply-actions" hx-post="/v2/reply" hx-target="#reply-slot" hx-select="#reply-slot" hx-swap="outerHTML" hx-push-url="false">
			<input type="hidden" name="messageId" value="${messageId}">
			<button class="reply-chip" name="mode" value="reply" data-reply="reply">${icon("reply")}Reply</button>
			<button class="reply-chip" name="mode" value="all" data-reply="all">${icon("reply-all")}Reply all</button>
			<button class="reply-chip" name="mode" value="forward" data-reply="forward">${icon("forward")}Forward</button>
		</form>
	</div>`;
}

export function renderThreadMain(ctx: V2Context, input: ThreadPageInput): Html {
	const { thread } = input;
	const latest = thread.messages[thread.messages.length - 1];
	const statuses = [...new Set(thread.messages.map((message) => message.folderId ? `folder:${message.folderId}` : message.status))];
	const chips = statuses
		.map((status) => status.startsWith("folder:")
			? input.folders.find((folder) => `folder:${folder.id}` === status)?.name
			: STATUS_LABELS[status])
		.filter((label): label is string => !!label);
	const inboxish = input.view === "spam" || input.view === "trash" || input.view === "archive";
	const canMove = input.view !== "drafts";
	const starred = thread.messages.some((message) => message.starred);
	return html`<main id="main" class="main" hx-history-elt>
	<div class="page" data-page="thread" data-view="${input.view}" data-list="${input.listHref}" data-newer="${input.newerHref ?? ""}" data-older="${input.olderHref ?? ""}" data-latest="${latest.id}">
		<div class="toolbar" role="toolbar" aria-label="Conversation actions">
			<a class="icon-button" href="${input.listHref}" title="Back (u)" aria-label="Back to list">${icon("arrow-left")}</a>
			<div class="tb-group">
				${inboxish
					? html`<button class="icon-button" form="thread-form" name="action" value="inbox" title="${input.view === "spam" ? "Not spam" : "Move to Inbox"}" aria-label="Move to Inbox">${icon("inbox")}</button>`
					: html`<button class="icon-button" form="thread-form" name="action" value="archive" title="Archive (e)" aria-label="Archive">${icon("archive")}</button>`}
				${input.view !== "spam" ? html`<button class="icon-button" form="thread-form" name="action" value="spam" title="Report spam (!)" aria-label="Report spam">${icon("alert")}</button>` : ""}
				${input.view !== "trash" ? html`<button class="icon-button" form="thread-form" name="action" value="trash" title="Delete (#)" aria-label="Delete">${icon("trash")}</button>` : ""}
				<span class="tb-sep"></span>
				<button class="icon-button" form="thread-form" name="action" value="unread" title="Mark as unread (Shift+U)" aria-label="Mark as unread">${icon("mail")}</button>
				${canMove ? snoozeMenu("thread-form") : ""}
				${canMove ? moveMenu("thread-form", input.folders) : ""}
				<button class="${cx("icon-button", "star-button", starred && "is-starred")}" form="thread-form" name="action" value="${starred ? "unstar" : "star"}" title="Star (s)" aria-pressed="${starred ? "true" : "false"}" aria-label="Star">${icon("star")}</button>
			</div>
			<div class="tb-spacer"></div>
			<div class="tb-pager">
				${input.index !== null && input.total ? html`<span class="tb-range">${formatCount(input.index + 1)} of ${formatCount(input.total)}</span>` : ""}
				${input.newerHref ? html`<a class="icon-button" href="${input.newerHref}" title="Newer (k)" aria-label="Newer conversation">${icon("chevron-left")}</a>` : html`<span class="icon-button is-disabled" aria-hidden="true">${icon("chevron-left")}</span>`}
				${input.olderHref ? html`<a class="icon-button" href="${input.olderHref}" title="Older (j)" aria-label="Older conversation">${icon("chevron-right")}</a>` : html`<span class="icon-button is-disabled" aria-hidden="true">${icon("chevron-right")}</span>`}
			</div>
		</div>
		<form id="thread-form" method="post" action="/v2/act">
			<input type="hidden" name="ids" value="${latest.id}">
			<input type="hidden" name="conversation" value="1">
			<input type="hidden" name="view" value="${input.view}">
			<input type="hidden" name="folder" value="${input.folderId ?? ""}">
			<input type="hidden" name="q" value="${input.q}">
			<input type="hidden" name="return" value="${input.listHref}" data-return>
			<input type="hidden" name="stay" value="${`${ctx.url.pathname}${ctx.url.search}`}">
		</form>
		<article class="thread">
			<header class="thread-head">
				<h1 class="thread-subject">${thread.subject?.trim() || "(no subject)"}</h1>
				<div class="thread-chips">${chips.map((chip) => html`<span class="chip">${chip}</span>`)}</div>
			</header>
			<div class="messages">
				${thread.messages.map((message, index) => renderMessage(message, input, input.expandedIds.has(message.id), index === thread.messages.length - 1))}
			</div>
			${input.replySlot ?? renderReplyButtons(latest.id)}
		</article>
	</div>
</main>`;
}

/** The "details" panel under a message's recipients. */
export function renderDetails(message: V2ThreadMessage, details: MessageHeaderDetails | null, hasOriginal: boolean, timeZone: string): Html {
	const rows: Array<[string, Html | string]> = [];
	const list = (value: string | null | undefined) => splitEmailAddressList(value).join(", ");
	rows.push(["from", message.fromAddr]);
	if (details?.replyTo) rows.push(["reply-to", details.replyTo]);
	rows.push(["to", list(message.toAddr) || "Undisclosed recipients"]);
	if (message.ccAddr) rows.push(["cc", list(message.ccAddr)]);
	if (message.bccAddr) rows.push(["bcc", list(message.bccAddr)]);
	const deliveredTo = details?.deliveredTo ?? message.deliveredTo;
	if (message.direction === "inbound" && deliveredTo) rows.push(["delivered to", deliveredTo]);
	rows.push(["date", details?.date ? html`${formatFullDate(message.createdAt, timeZone)} <span class="muted">· ${details.date}</span>` : formatFullDate(message.createdAt, timeZone)]);
	rows.push(["subject", message.subject ?? "(no subject)"]);
	if (details?.mailedBy) rows.push(["mailed-by", html`${details.mailedBy}${details.envelopeFrom ? html` <span class="muted">(${details.envelopeFrom})</span>` : ""}`]);
	if (details?.signedBy.length) rows.push(["signed-by", details.signedBy.join(", ")]);
	const security = formatTransportSecurity(details?.transportSecurity ?? null);
	if (security) rows.push(["security", security]);
	const auth = summarizeAuthentication(details?.authentication ?? []);
	if (auth.length) {
		rows.push(["authentication", html`${auth.map((item) => html`<span class="${cx("auth", `is-${item.tone}`)}"><strong>${item.label}</strong> ${item.checks.map(formatAuthenticationCheck).join(", ")}</span>`)}${details?.authservId ? html`<span class="muted auth-by">checked by ${details.authservId}</span>` : ""}`]);
	}
	if (details?.listId) rows.push(["list", details.listId]);
	if (details?.messageId) rows.push(["message-id", html`<code>${details.messageId}</code>`]);
	return html`<div class="msg-details" id="${`details-${message.id}`}">
		<dl>${rows.map(([label, value]) => html`<dt>${label}:</dt><dd>${value}</dd>`)}</dl>
		${hasOriginal ? html`<div class="details-links">
			<details class="all-headers"><summary>All headers (${details?.headers.length ?? 0})</summary><pre>${(details?.headers ?? []).map((header) => `${header.name}: ${header.value}`).join("\n")}</pre></details>
			<a href="${`/api/messages/${message.id}/original`}" target="_blank" rel="noopener" hx-boost="false">Show original</a>
			<a href="${`/api/messages/${message.id}/original?download=1`}" hx-boost="false">Download .eml</a>
		</div>` : html`<p class="muted">The original message is not stored, so only these fields are available.</p>`}
	</div>`;
}
