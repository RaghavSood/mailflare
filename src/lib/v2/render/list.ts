import { cx, html, type Html } from "../html";
import { icon } from "../icons";
import { listHref, threadHref } from "../paths";
import type { V2Context, V2Folder, V2ListPage, V2ListRow, V2ViewKey } from "../types";
import { avatarHue, formatCount, formatListDate, initials } from "./format";
import { moveMenu, snoozeMenu } from "./menus";

export type ListPageInput = {
	view: V2ViewKey;
	title: string;
	folderId: string | null;
	q: string;
	page: V2ListPage;
	folders: V2Folder[];
	timeZone: string;
	emptyText: string;
};

const STATUS_LABELS: Record<string, string> = {
	received: "Inbox",
	archived: "Archive",
	sent: "Sent",
	queued: "Scheduled",
	spam: "Spam",
	trash: "Trash",
};

function rowLabels(row: V2ListRow, view: V2ViewKey, folders: V2Folder[]): Html {
	if (view !== "all" && view !== "search" && view !== "starred") return html``;
	const folder = row.folderId ? folders.find((item) => item.id === row.folderId) : null;
	const label = folder ? folder.name : STATUS_LABELS[row.status];
	return label ? html`<span class="chip">${label}</span>` : html``;
}

function renderRow(row: V2ListRow, index: number, input: ListPageInput): Html {
	const href = input.view === "drafts"
		? `/v2/drafts/${row.id}`
		: threadHref(input.view, row.id, { folderId: input.folderId, q: input.q || null, i: (input.page.page - 1) * input.page.pageSize + index });
	// The avatar shows who the conversation is with, never "me".
	const lead = [...row.participants].reverse().find((participant) => participant.name !== "me")?.name ?? row.participants[0]?.name ?? row.fromAddr;
	const seed = row.direction === "outbound" ? row.toAddr : row.fromAddr;
	return html`<li class="${cx("row", row.unread && "is-unread")}" data-row data-id="${row.id}" data-href="${href}">
		<label class="row-select" title="Select (x)">
			<input type="checkbox" name="ids" value="${row.id}" data-row-check aria-label="${`Select conversation from ${lead}`}">
			<span class="avatar" style="${`--hue:${avatarHue(seed)}`}" aria-hidden="true">${initials(lead.replace(/^To: /, ""))}</span>
			<span class="check-mark" aria-hidden="true">${icon("check")}</span>
		</label>
		<button type="button" class="${cx("row-star", row.starred && "is-starred")}" data-star="${row.id}" aria-pressed="${row.starred ? "true" : "false"}" aria-label="${row.starred ? "Starred" : "Not starred"}" title="Star (s)">${icon("star")}</button>
		<a class="row-link" href="${href}">
			<span class="row-from">
				${input.view === "drafts" ? html`<span class="draft-label">Draft</span> ` : ""}
				${row.participants.map((participant, position) => html`${position > 0 ? ", " : ""}<span class="${cx(participant.unread && "is-unread")}">${participant.name}</span>`)}
				${row.count > 1 ? html`<span class="row-count">${row.count}</span>` : ""}
			</span>
			<span class="row-main">
				${rowLabels(row, input.view, input.folders)}
				<span class="row-subject">${row.subject?.trim() || "(no subject)"}</span>
				${row.snippet ? html`<span class="row-snippet"><span class="row-dash"> – </span>${row.snippet}</span>` : ""}
			</span>
			<span class="row-meta">
				${row.hasAttachments ? html`<span class="row-clip" title="Has attachments">${icon("paperclip")}</span>` : ""}
				<time datetime="${row.createdAt.toISOString()}">${formatListDate(row.createdAt, input.timeZone)}</time>
			</span>
		</a>
		${input.view !== "drafts" ? html`<span class="row-hover">
			${input.view === "inbox" || input.view === "folder" || input.view === "all" || input.view === "starred" || input.view === "search"
				? html`<button type="button" class="icon-button" data-row-action="archive" title="Archive (e)" aria-label="Archive">${icon("archive")}</button>`
				: input.view === "spam" || input.view === "trash" || input.view === "archive"
					? html`<button type="button" class="icon-button" data-row-action="inbox" title="Move to Inbox" aria-label="Move to Inbox">${icon("inbox")}</button>`
					: ""}
			${input.view !== "trash" ? html`<button type="button" class="icon-button" data-row-action="trash" title="Delete (#)" aria-label="Delete">${icon("trash")}</button>` : ""}
			<button type="button" class="icon-button" data-row-action="${row.unread ? "read" : "unread"}" title="${row.unread ? "Mark as read (Shift+I)" : "Mark as unread (Shift+U)"}" aria-label="${row.unread ? "Mark as read" : "Mark as unread"}">${icon(row.unread ? "mail-open" : "mail")}</button>
		</span>` : ""}
	</li>`;
}

export function renderListMain(ctx: V2Context, input: ListPageInput): Html {
	const { page } = input;
	const start = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
	const end = Math.min(page.page * page.pageSize, page.total);
	const hasPrev = page.page > 1;
	const hasNext = end < page.total;
	const current = `${ctx.url.pathname}${ctx.url.search}`;
	const prevHref = listHref(input.view, { folderId: input.folderId, q: input.q, page: page.page - 1 });
	const nextHref = listHref(input.view, { folderId: input.folderId, q: input.q, page: page.page + 1 });
	const canMove = input.view !== "drafts" && input.view !== "sent";
	return html`<main id="main" class="main" hx-history-elt>
	<div class="page" data-page="list" data-view="${input.view}" data-prev="${hasPrev ? prevHref : ""}" data-next="${hasNext ? nextHref : ""}">
		<div class="toolbar" role="toolbar" aria-label="Conversation actions">
			<label class="tb-select" title="Select all (* a)">
				<input type="checkbox" data-select-all aria-label="Select all conversations">
			</label>
			<div class="tb-group tb-idle">
				<a class="icon-button" href="${current}" title="Refresh (Shift+N)" aria-label="Refresh">${icon("refresh")}</a>
				<span class="tb-title">${input.title}</span>
			</div>
			<div class="tb-group tb-selected">
				<span class="tb-count" data-selected-count></span>
				${input.view === "spam" || input.view === "archive" || input.view === "trash"
					? html`<button class="icon-button" form="list-form" name="action" value="inbox" title="${input.view === "spam" ? "Not spam" : "Move to Inbox"}" aria-label="Move to Inbox">${icon("inbox")}</button>`
					: html`<button class="icon-button" form="list-form" name="action" value="archive" title="Archive (e)" aria-label="Archive">${icon("archive")}</button>`}
				${input.view !== "spam" && input.view !== "drafts" ? html`<button class="icon-button" form="list-form" name="action" value="spam" title="Report spam (!)" aria-label="Report spam">${icon("alert")}</button>` : ""}
				${input.view !== "trash" ? html`<button class="icon-button" form="list-form" name="action" value="trash" title="Delete (#)" aria-label="Delete">${icon("trash")}</button>` : ""}
				<span class="tb-sep"></span>
				<button class="icon-button" form="list-form" name="action" value="read" title="Mark as read (Shift+I)" aria-label="Mark as read">${icon("mail-open")}</button>
				<button class="icon-button" form="list-form" name="action" value="unread" title="Mark as unread (Shift+U)" aria-label="Mark as unread">${icon("mail")}</button>
				${canMove ? snoozeMenu("list-form") : ""}
				${canMove ? moveMenu("list-form", input.folders) : ""}
			</div>
			<div class="tb-spacer"></div>
			<div class="tb-pager">
				<span class="tb-range">${page.total ? html`${formatCount(start)}–${formatCount(end)} of ${formatCount(page.total)}` : ""}</span>
				${hasPrev ? html`<a class="icon-button" href="${prevHref}" title="Newer (g p)" aria-label="Newer">${icon("chevron-left")}</a>` : html`<span class="icon-button is-disabled" aria-hidden="true">${icon("chevron-left")}</span>`}
				${hasNext ? html`<a class="icon-button" href="${nextHref}" title="Older (g n)" aria-label="Older">${icon("chevron-right")}</a>` : html`<span class="icon-button is-disabled" aria-hidden="true">${icon("chevron-right")}</span>`}
			</div>
		</div>
		<form id="list-form" class="list" method="post" action="/v2/act">
			<input type="hidden" name="view" value="${input.view}">
			<input type="hidden" name="folder" value="${input.folderId ?? ""}">
			<input type="hidden" name="q" value="${input.q}">
			<input type="hidden" name="return" value="${current}">
			${page.rows.length
				? html`<ul class="rows" role="list">${page.rows.map((row, index) => renderRow(row, index, input))}</ul>`
				: html`<div class="empty">${icon(input.view === "search" ? "search" : "inbox", "icon empty-icon")}<p>${input.q ? `No conversations match “${input.q}”.` : input.emptyText}</p></div>`}
		</form>
	</div>
</main>`;
}
