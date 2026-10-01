import { getEmailAddressList } from "@/lib/email/address";
import { html, type Html } from "./html";
import { getView, listHref, parseV2Path, threadHref } from "./paths";
import type { V2Context, V2ViewKey } from "./types";
import { loadCounts, loadFolder, loadFolders } from "./data/context";
import { emptyDraft, loadDraft } from "./data/compose";
import { loadList, loadListWindow, V2_PAGE_SIZE } from "./data/list";
import { loadThread, markRead } from "./data/thread";
import { renderComposePageMain, renderComposer } from "./render/compose";
import { resolveTimeZone } from "./render/format";
import { renderPage, type NavState } from "./render/layout";
import { renderListMain } from "./render/list";
import { renderThreadMain } from "./render/thread";

export type PageResult = { status: number; body: Html };

const EMPTY_TEXT: Record<V2ViewKey, string> = {
	inbox: "You're all caught up.",
	starred: "Star conversations to find them here.",
	snoozed: "Snoozed conversations come back to your inbox when it's time.",
	sent: "Nothing sent yet.",
	drafts: "No drafts.",
	archive: "Archived conversations land here.",
	all: "No mail yet.",
	spam: "No spam. Nice.",
	trash: "Trash is empty.",
	folder: "This folder is empty.",
	search: "Search your mail with words, from:, to:, subject:, has:attachment, before: and after:.",
};

export function timeZoneOf(ctx: V2Context): string {
	return resolveTimeZone(readCookie(ctx.request, "mf_tz"));
}

export function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get("cookie") ?? "";
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) {
			try {
				return decodeURIComponent(rest.join("="));
			} catch {
				return null;
			}
		}
	}
	return null;
}

async function navState(ctx: V2Context, active: NavState["active"]): Promise<NavState> {
	const counts = await loadCounts(ctx.env, ctx.scopeMailboxIds);
	const folders = await loadFolders(ctx.env, ctx.scopeMailboxIds, counts);
	return { counts, folders, active };
}

function pageTitle(label: string, unread: number, ctx: V2Context): string {
	const mailbox = ctx.mailboxes.find((item) => item.id === ctx.selectedMailboxId) ?? (ctx.mailboxes.length === 1 ? ctx.mailboxes[0] : null);
	return `${label}${unread > 0 ? ` (${unread})` : ""}${mailbox ? ` - ${mailbox.address}` : ""} - Mailflare`;
}

function notFound(ctx: V2Context, nav: NavState, message = "That page doesn't exist."): PageResult {
	return {
		status: 404,
		body: renderPage(ctx, {
			title: "Not found - Mailflare",
			nav,
			main: html`<main id="main" class="main" hx-history-elt><div class="page" data-page="empty"><div class="empty"><p>${message}</p><p><a class="button" href="/v2/inbox">Go to Inbox</a></p></div></div></main>`,
		}),
	};
}

/** Render whatever page `ctx.url` names. Used for GETs and to answer actions. */
export async function renderRoute(ctx: V2Context, extras: { toast?: Html | null } = {}): Promise<PageResult> {
	const route = parseV2Path(ctx.url.pathname);
	if (route.kind !== "view") {
		return notFound(ctx, await navState(ctx, { view: "inbox", folderId: null }));
	}
	const q = ctx.url.searchParams.get("q")?.trim() ?? "";
	const timeZone = timeZoneOf(ctx);

	if (route.view === "drafts" && route.messageId) {
		const draft = await loadDraft(ctx.env, ctx.user, route.messageId);
		const nav = await navState(ctx, { view: "drafts", folderId: null });
		if (!draft) return notFound(ctx, nav, "That draft was sent or discarded.");
		const composer = renderComposer(draft, { mailboxes: ctx.mailboxes, mode: "page", key: draft.id ?? "page", returnHref: listHref("drafts") });
		return { status: 200, body: renderPage(ctx, { title: `${draft.subject || "Draft"} - Mailflare`, nav, q, main: renderComposePageMain(composer), toast: extras.toast }) };
	}

	let folderName: string | null = null;
	if (route.view === "folder") {
		const folder = route.folderId ? await loadFolder(ctx.env, route.folderId, ctx.scopeMailboxIds) : null;
		if (!folder) return notFound(ctx, await navState(ctx, { view: "inbox", folderId: null }), "That folder doesn't exist.");
		folderName = folder.name;
	}
	const label = route.view === "folder"
		? folderName ?? "Folder"
		: route.view === "search"
			? q ? `Search results for “${q}”` : "Search"
			: getView(route.view)?.label ?? "Mail";

	if (route.messageId) {
		const thread = await loadThread(ctx.env, { messageId: route.messageId, view: route.view, scopeMailboxIds: ctx.scopeMailboxIds });
		if (!thread) return notFound(ctx, await navState(ctx, { view: route.view, folderId: route.folderId }), "That conversation was moved or deleted.");
		const unreadIds = thread.messages.filter((message) => message.direction === "inbound" && !message.read).map((message) => message.id);
		if (unreadIds.length) await markRead(ctx.env, ctx.user, unreadIds);
		const nav = await navState(ctx, { view: route.view, folderId: route.folderId });
		const indexParam = Number(ctx.url.searchParams.get("i"));
		const index = Number.isInteger(indexParam) && indexParam >= 0 ? indexParam : null;
		const window = index === null ? null : await loadListWindow(ctx.env, { view: route.view, scopeMailboxIds: ctx.scopeMailboxIds, folderId: route.folderId, q, index });
		const linkTo = (id: string | null, position: number) => (id ? threadHref(route.view, id, { folderId: route.folderId, q: q || null, i: position }) : null);
		const listPage = index === null ? undefined : Math.floor(index / V2_PAGE_SIZE) + 1;
		const own = new Set(ctx.mailboxes.flatMap((mailbox) => [mailbox.address, ...mailbox.senderAddresses]));
		for (const message of thread.messages) {
			if (message.direction === "outbound") for (const address of getEmailAddressList(message.fromAddr)) own.add(address);
			if (message.deliveredTo) own.add(message.deliveredTo.toLowerCase());
		}
		const latest = thread.messages[thread.messages.length - 1];
		const expandedIds = new Set([latest.id, ...unreadIds]);
		const main = renderThreadMain(ctx, {
			view: route.view,
			folderId: route.folderId,
			q,
			thread,
			listHref: listHref(route.view, { folderId: route.folderId, q: q || null, page: listPage }),
			index,
			total: window?.total ?? null,
			newerHref: window && index !== null ? linkTo(window.newer, index - 1) : null,
			olderHref: window && index !== null ? linkTo(window.older, index + 1) : null,
			folders: nav.folders,
			timeZone,
			ownAddresses: own,
			expandedIds,
		});
		return { status: 200, body: renderPage(ctx, { title: `${thread.subject?.trim() || "(no subject)"} - Mailflare`, nav, q, main, toast: extras.toast }) };
	}

	const pageNumber = Math.max(1, Math.min(10_000, Number(ctx.url.searchParams.get("page")) || 1));
	const nav = await navState(ctx, { view: route.view, folderId: route.folderId });
	const page = await loadList(ctx.env, {
		view: route.view,
		scopeMailboxIds: ctx.scopeMailboxIds,
		mailboxes: ctx.mailboxes,
		folderId: route.folderId,
		q,
		offset: (pageNumber - 1) * V2_PAGE_SIZE,
		limit: V2_PAGE_SIZE,
	});
	const unread = route.view === "inbox" ? nav.counts.inbox : route.view === "spam" ? nav.counts.spam : 0;
	const main = renderListMain(ctx, {
		view: route.view,
		title: label,
		folderId: route.folderId,
		q,
		page,
		folders: nav.folders,
		timeZone,
		emptyText: EMPTY_TEXT[route.view],
	});
	return { status: 200, body: renderPage(ctx, { title: pageTitle(label, unread, ctx), nav, q, main, toast: extras.toast }) };
}

/** A full-page composer (mobile compose, "compose in a new tab"). */
export async function renderComposePage(ctx: V2Context, draftId: string | null): Promise<PageResult> {
	const nav = await navState(ctx, { view: "drafts", folderId: null });
	const draft = draftId ? await loadDraft(ctx.env, ctx.user, draftId) : emptyDraft(defaultSender(ctx));
	if (!draft) return notFound(ctx, nav, "That draft was sent or discarded.");
	const composer = renderComposer(draft, { mailboxes: ctx.mailboxes, mode: "page", key: draft.id ?? "new", returnHref: "/v2/inbox" });
	return { status: 200, body: renderPage(ctx, { title: "Compose - Mailflare", nav, main: renderComposePageMain(composer) }) };
}

export function defaultSender(ctx: V2Context) {
	const sendable = ctx.mailboxes.filter((mailbox) => mailbox.canSend);
	return sendable.find((mailbox) => mailbox.id === ctx.selectedMailboxId)
		?? sendable.find((mailbox) => mailbox.address === ctx.user.email)
		?? sendable[0];
}
