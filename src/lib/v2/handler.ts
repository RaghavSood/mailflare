import { and, eq, inArray, like, or } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import { getSessionTokenFromRequestHeaders, getUserFromSession } from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/types";
import type { AttachmentContent } from "@/lib/email/attachment-types";
import { getMessageHeaderDetailsForUser } from "@/lib/email/message-headers";
import { MessageActionError } from "@/lib/messages/actions";
import { html, type Html } from "./html";
import { classicToV2, listHref, parseV2Path, safeReturnPath, v2ToClassic } from "./paths";
import { UI_PREFERENCE_COOKIE } from "./preference";
import { withQueryTimer, type QueryTimer } from "./timing";
import type { V2Context, V2Mailbox, V2Theme, V2ViewKey } from "./types";
import { loadFolder, loadMailboxes } from "./data/context";
import {
	createReplyDraft,
	discardDraft,
	emptyDraft,
	loadDraft,
	removeDraftAttachment,
	saveDraft,
	sendCompose,
	type ComposeInput,
} from "./data/compose";
import { parseFromValue } from "./data/compose-utils";
import { loadThread, markUnreadFrom, resolveActionTargets, restoreMessages, runAction, setConversationStar, setSnooze } from "./data/thread";
import { parseUndoEntries, type UndoEntry } from "./data/thread-utils";
import { resolveSnoozeTime } from "./data/time-utils";
import { defaultSender, navStateFor, readCookie, renderComposePage, renderRoute, timeZoneOf, withSenders, writeScope } from "./pages";
import { renderNav, renderToast } from "./render/layout";
import { renderComposer, renderDock } from "./render/compose";
import { formatFullDate } from "./render/format";
import { renderDetails, renderMessageBody } from "./render/thread";

const VIEW_KEYS = new Set<V2ViewKey>(["inbox", "starred", "snoozed", "sent", "drafts", "archive", "all", "spam", "trash", "folder", "search"]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const YEAR = 60 * 60 * 24 * 365;

const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	// Email bodies render in srcdoc frames, which inherit this policy; they need
	// their inline styles and remote images.
	"style-src 'self' 'unsafe-inline'",
	"img-src * data: blob:",
	"font-src * data:",
	"media-src * data: blob:",
	"connect-src 'self' ws: wss:",
	"frame-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

function securityHeaders(headers: Headers): Headers {
	headers.set("Content-Security-Policy", CSP);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Referrer-Policy", "same-origin");
	headers.set("Cache-Control", "no-store");
	headers.set("Vary", "HX-Request, Cookie");
	return headers;
}

function htmlResponse(body: Html | string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
	const headers = securityHeaders(new Headers(init.headers));
	headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(String(body), { status: init.status ?? 200, headers });
}

function jsonResponse(value: unknown, status = 200): Response {
	const headers = securityHeaders(new Headers());
	headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify(value), { status, headers });
}

function redirect(location: string, cookies: string[] = []): Response {
	const headers = securityHeaders(new Headers({ Location: location }));
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return new Response(null, { status: 303, headers });
}

function cookie(name: string, value: string, url: URL): string {
	return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${YEAR}; SameSite=Lax; HttpOnly${url.protocol === "https:" ? "; Secure" : ""}`;
}

/** Cookie-authenticated POSTs must come from this origin. */
function isSameOrigin(request: Request, url: URL): boolean {
	const origin = request.headers.get("origin");
	if (origin) return origin === url.origin;
	const site = request.headers.get("sec-fetch-site");
	return site === "same-origin" || site === "none";
}

/**
 * Who is signed in and their mailboxes barely change between clicks, but cost
 * several sequential queries. Each isolate remembers them per session for a
 * few seconds; a sign-out or password change takes effect within that time.
 */
const IDENTITY_TTL_MS = 15_000;
const identityCache = new Map<string, { user: SessionUser; mailboxes: V2Mailbox[]; expires: number }>();

async function loadIdentity(env: CloudflareEnv, request: Request): Promise<{ user: SessionUser; mailboxes: V2Mailbox[] } | null> {
	const token = getSessionTokenFromRequestHeaders(request);
	if (!token) return null;
	const now = Date.now();
	const cached = identityCache.get(token);
	if (cached && cached.expires > now) return cached;
	const user = await getUserFromSession(env, token);
	if (!user || user.disabled) {
		identityCache.delete(token);
		return null;
	}
	const mailboxes = await loadMailboxes(env, user as SessionUser);
	if (identityCache.size >= 500) {
		for (const [key, entry] of identityCache) if (entry.expires <= now || identityCache.size >= 500) identityCache.delete(key);
	}
	const identity = { user: user as SessionUser, mailboxes, expires: now + IDENTITY_TTL_MS };
	identityCache.set(token, identity);
	return identity;
}

function buildContext(env: CloudflareEnv, request: Request, user: SessionUser, mailboxes: V2Mailbox[], url: URL): V2Context {
	const selected = readCookie(request, "mf_mb");
	const selectedMailboxId = selected && mailboxes.some((mailbox) => mailbox.id === selected) ? selected : null;
	const theme = readCookie(request, "mf_theme");
	return {
		env,
		request,
		user,
		url,
		mailboxes,
		scopeMailboxIds: selectedMailboxId ? [selectedMailboxId] : mailboxes.map((mailbox) => mailbox.id),
		selectedMailboxId,
		theme: theme === "light" || theme === "dark" ? theme : "system",
		shortcutsEnabled: user.keyboardShortcutsEnabled !== false,
		htmx: request.headers.get("hx-request") === "true",
	};
}

/** The page htmx says the request came from, as a path. */
function currentPagePath(request: Request, url: URL): string | null {
	const value = request.headers.get("hx-current-url");
	if (!value) return null;
	try {
		const current = new URL(value);
		return current.origin === url.origin ? `${current.pathname}${current.search}` : null;
	} catch {
		return null;
	}
}

/** The same context pointed at another v2 URL, to answer an action with that page. */
function at(ctx: V2Context, path: string): V2Context {
	return { ...ctx, url: new URL(safeReturnPath(path), ctx.url.origin) };
}

async function respondWithPage(ctx: V2Context, path: string, options: { toast?: Html | null; push?: boolean } = {}): Promise<Response> {
	const target = safeReturnPath(path);
	if (!ctx.htmx) return redirect(target);
	const page = await renderRoute(at(ctx, target), { toast: options.toast });
	// Actions are POSTs to /v2/act and friends; only push a URL when the view changes.
	return htmlResponse(page.body, { status: page.status, headers: { "HX-Push-Url": options.push ? target : "false" } });
}

function toastWithUndo(message: string, undo: { kind: "restore"; entries: UndoEntry[] } | { kind: "unsnooze"; ids: string[] } | null, returnTo: string): Html {
	if (!undo) return html`<span>${message}</span>`;
	return html`<span>${message}</span>
		<form method="post" action="/v2/undo" class="inline-form">
			<input type="hidden" name="undo" value="${JSON.stringify(undo)}">
			<input type="hidden" name="return" value="${returnTo}">
			<button type="submit" class="toast-action" data-undo>Undo</button>
		</form>`;
}

function describe(action: string, conversations: number, extra = ""): string {
	const subject = conversations === 1 ? "Conversation" : `${conversations} conversations`;
	switch (action) {
		case "archive": return `${subject} archived.`;
		case "trash": return `${subject} moved to Trash.`;
		case "spam": return `${subject} marked as spam.`;
		case "inbox": return `${subject} moved to Inbox.`;
		case "folder": return `${subject} moved to ${extra}.`;
		case "read": return `${subject} marked as read.`;
		case "unread": return `${subject} marked as unread.`;
		default: return "Done.";
	}
}

async function handleAct(ctx: V2Context, form: FormData): Promise<Response> {
	const ids = form.getAll("ids").map(String).filter((id) => ID.test(id));
	const viewValue = String(form.get("view") ?? "inbox") as V2ViewKey;
	const view = VIEW_KEYS.has(viewValue) ? viewValue : "inbox";
	const folderId = String(form.get("folder") ?? "") || null;
	const q = String(form.get("q") ?? "") || null;
	const conversation = form.get("conversation") === "1";
	const returnTo = safeReturnPath(String(form.get("return") ?? ""), listHref(view, { folderId }));
	const stay = safeReturnPath(String(form.get("stay") ?? ""), returnTo);
	const base = { ids, view, folderId, q, scopeMailboxIds: ctx.scopeMailboxIds, conversation };
	const conversations = new Set(ids).size;
	// Background updates from the page (a star toggled in the list) need no page
	// back. List actions are applied to the rows in the browser already, so they
	// only need the navigation counts and the toast; a failure tells the page to
	// reload the list.
	const quiet = form.get("quiet") === "1";
	const partial = form.get("partial") === "1" && !conversation;
	const respond = async (path: string, options: { toast?: Html | null; push?: boolean; failed?: boolean } = {}): Promise<Response> => {
		if (quiet) return new Response(null, { status: options.failed ? 422 : 204, headers: securityHeaders(new Headers()) });
		if (partial) {
			if (options.failed) {
				// The page shows this as a toast through textContent.
				const text = options.toast
					? String(options.toast).replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim()
					: "Something went wrong.";
				return new Response(text, { status: 422, headers: securityHeaders(new Headers({ "Content-Type": "text/plain; charset=utf-8" })) });
			}
			const nav = await navStateFor(ctx, { view, folderId });
			return htmlResponse(html`${renderNav(ctx, nav)}${renderToast(options.toast ?? null)}`, { headers: { "HX-Push-Url": "false" } });
		}
		return respondWithPage(ctx, path, options);
	};
	if (ids.length === 0) {
		return respond(conversation ? stay : returnTo, { toast: html`<span>Select a conversation first.</span>`, failed: true });
	}

	const snooze = form.get("snooze");
	if (snooze) {
		const until = resolveSnoozeTime(String(snooze), String(form.get("snoozeAt") ?? "") || null, timeZoneOf(ctx));
		if (!until) return respond(conversation ? stay : returnTo, { toast: html`<span>Pick a time in the future.</span>`, failed: true });
		const targets = await resolveActionTargets(ctx.env, { ...base, action: "snooze" });
		await setSnooze(ctx.env, writeScope(ctx), targets, until);
		const undo = { kind: "unsnooze" as const, ids: targets.map((target) => target.id) };
		return respond(returnTo, {
			toast: toastWithUndo(`Snoozed until ${formatFullDate(until, timeZoneOf(ctx))}.`, undo, returnTo),
			push: conversation,
		});
	}

	let action = String(form.get("action") ?? "");
	let moveFolder: string | null = null;
	const move = String(form.get("move") ?? "");
	if (move) {
		if (move.startsWith("folder:") && ID.test(move.slice(7))) {
			action = "folder";
			moveFolder = move.slice(7);
		} else {
			action = move;
		}
	}

	if (action === "star" || action === "unstar") {
		const targets = await resolveActionTargets(ctx.env, { ...base, action });
		await setConversationStar(ctx.env, writeScope(ctx), targets, action === "star");
		return respond(conversation ? stay : returnTo);
	}

	const allowed: BulkMessageAction[] = ["archive", "trash", "spam", "inbox", "read", "unread", "folder"];
	if (!allowed.includes(action as BulkMessageAction)) {
		return respond(conversation ? stay : returnTo, { toast: html`<span>That action isn't available here.</span>`, failed: true });
	}
	const targets = await resolveActionTargets(ctx.env, { ...base, action: action as BulkMessageAction });
	if (targets.length === 0) {
		return respond(conversation ? stay : returnTo, { toast: html`<span>Nothing to change.</span>`, failed: true });
	}
	let undoEntries: UndoEntry[];
	try {
		undoEntries = await runAction(ctx.env, ctx.user, targets, action as BulkMessageAction, moveFolder);
	} catch (error) {
		if (error instanceof MessageActionError) {
			return respond(conversation ? stay : returnTo, { toast: html`<span>${error.message}</span>`, failed: true });
		}
		throw error;
	}
	const folderName = moveFolder ? (await loadFolder(ctx.env, moveFolder, ctx.scopeMailboxIds))?.name ?? "folder" : "";
	// Marking read keeps a conversation open; everything else leaves it.
	const destination = conversation && action === "read" ? stay : returnTo;
	const undoable = action !== "read" && action !== "unread";
	return respond(destination, {
		toast: toastWithUndo(describe(action, conversations, folderName), undoable ? { kind: "restore", entries: undoEntries } : null, destination),
		push: conversation,
	});
}

async function handleUndo(ctx: V2Context, form: FormData): Promise<Response> {
	const returnTo = safeReturnPath(String(form.get("return") ?? ""));
	let payload: { kind?: string; entries?: unknown; ids?: unknown } = {};
	try {
		payload = JSON.parse(String(form.get("undo") ?? "{}"));
	} catch {
		payload = {};
	}
	if (payload.kind === "restore") {
		await restoreMessages(ctx.env, writeScope(ctx), parseUndoEntries(JSON.stringify(payload.entries ?? [])));
	} else if (payload.kind === "unsnooze" && Array.isArray(payload.ids)) {
		const ids = payload.ids.filter((id): id is string => typeof id === "string" && ID.test(id)).slice(0, 500);
		const targets = ids.map((id) => ({ id, key: id, direction: "inbound" as const, status: "received", folderId: null, read: true, starred: false, createdAt: new Date() }));
		await setSnooze(ctx.env, writeScope(ctx), targets, null);
	}
	return respondWithPage(ctx, returnTo, { toast: html`<span>Action undone.</span>` });
}

function composeInputFrom(form: FormData, ctx: V2Context): ComposeInput | { error: string } {
	let from = parseFromValue(String(form.get("from") ?? ""));
	if (from?.address === "*") {
		const custom = String(form.get("customFrom") ?? "").trim().toLowerCase();
		from = custom ? { mailboxId: from.mailboxId, address: custom } : null;
	}
	if (!from) return { error: "Choose who the message is from." };
	if (!ctx.mailboxes.some((mailbox) => mailbox.id === from.mailboxId && mailbox.canSend)) return { error: "You can't send from that mailbox." };
	const draftId = String(form.get("draftId") ?? "");
	return {
		draftId: ID.test(draftId) ? draftId : null,
		mailboxId: from.mailboxId,
		from: from.address,
		to: String(form.get("to") ?? ""),
		cc: String(form.get("cc") ?? ""),
		bcc: String(form.get("bcc") ?? ""),
		subject: String(form.get("subject") ?? "").slice(0, 500),
		bodyHtml: String(form.get("html") ?? "").slice(0, 2 * 1024 * 1024),
		inReplyTo: String(form.get("inReplyTo") ?? "") || null,
		references: String(form.get("references") ?? "") || null,
		threadId: String(form.get("threadId") ?? "") || null,
	};
}

async function handleSend(ctx: V2Context, form: FormData): Promise<Response> {
	const input = composeInputFrom(form, ctx);
	if ("error" in input) return htmlResponse(input.error, { status: 422 });
	if (!input.to.trim()) return htmlResponse("Add at least one recipient.", { status: 422 });
	const uploads: AttachmentContent[] = [];
	for (const value of form.getAll("attachments")) {
		if (!(value instanceof File) || value.size === 0) continue;
		uploads.push({ filename: value.name, type: value.type || "application/octet-stream", content: await value.arrayBuffer(), disposition: "attachment" });
	}
	try {
		await sendCompose(ctx.env, ctx.user, { ...input, uploads });
	} catch (error) {
		return htmlResponse(error instanceof Error ? error.message : "Sending failed.", { status: 422 });
	}
	const returnTo = safeReturnPath(String(form.get("return") ?? ""));
	return respondWithPage(ctx, returnTo, { toast: html`<span>Message sent.</span>` });
}

async function handleContacts(ctx: V2Context): Promise<Response> {
	const q = (ctx.url.searchParams.get("q") ?? "").trim().toLowerCase().replace(/[%_\\]/g, "");
	if (q.length < 1) return jsonResponse({ contacts: [] });
	const owners = [...new Set(ctx.mailboxes.map((mailbox) => mailbox.userId))];
	const rows = await getDb(ctx.env)
		.select({ email: contacts.email, name: contacts.displayName })
		.from(contacts)
		.where(and(inArray(contacts.userId, owners), eq(contacts.blocked, false), or(like(contacts.email, `%${q}%`), like(contacts.displayName, `%${q}%`))))
		.limit(8);
	return jsonResponse({ contacts: rows });
}

async function findMessage(ctx: V2Context, messageId: string) {
	if (!ID.test(messageId)) return null;
	const thread = await loadThread(ctx.env, { messageId, view: "trash", scopeMailboxIds: ctx.scopeMailboxIds });
	return thread?.messages.find((message) => message.id === messageId) ?? null;
}

/**
 * Entry point for /v2. Pages are GETs that render HTML; actions are same-origin
 * POSTs that answer with the page to show next (htmx swaps #main) or redirect
 * when script is off.
 */
export async function handleV2Request(request: Request, env: CloudflareEnv): Promise<Response> {
	const timer: QueryTimer = { calls: 0, ms: 0 };
	const start = performance.now();
	const response = await route(request, withQueryTimer(env, timer));
	// Visible in the browser's network panel: time in the handler, and how much
	// of it was spent waiting on D1.
	const total = performance.now() - start;
	const headers = new Headers(response.headers);
	headers.set("Server-Timing", `app;dur=${total.toFixed(1)}, db;dur=${timer.ms.toFixed(1)};desc="${timer.calls} D1 calls"`);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function route(request: Request, env: CloudflareEnv): Promise<Response> {
	const url = new URL(request.url);
	const method = request.method.toUpperCase();
	const route = parseV2Path(url.pathname);

	if (route.kind === "action" && route.name === "switch") {
		// The toggle between interfaces remembers the choice for the next login.
		const to = url.searchParams.get("to") === "classic" ? "classic" : "v2";
		const from = url.searchParams.get("from") ?? "";
		const location = to === "classic" ? v2ToClassic(from) : classicToV2(from);
		return redirect(location, [cookie(UI_PREFERENCE_COOKIE, to, url)]);
	}

	if (method === "POST" && !isSameOrigin(request, url)) return htmlResponse("Forbidden", { status: 403 });
	const identity = await loadIdentity(env, request);
	if (!identity) {
		if (method === "GET") return redirect(`/login`);
		return htmlResponse("Your session has ended. Sign in again.", { status: 401 });
	}
	const { user } = identity;
	const ctx = buildContext(env, request, user, identity.mailboxes, url);

	if (route.kind === "home") return redirect("/v2/inbox");
	if (route.kind === "notFound") {
		const page = await renderRoute(ctx);
		return htmlResponse(page.body, { status: 404 });
	}

	if (method === "GET") {
		if (route.kind === "view") {
			const page = await renderRoute(ctx);
			return htmlResponse(page.body, { status: page.status });
		}
		const [name, id] = route.name.split("/");
		if (name === "compose") {
			if (id === "new") {
				const composeCtx = await withSenders(ctx);
				const composer = renderComposer(emptyDraft(defaultSender(composeCtx)), { mailboxes: composeCtx.mailboxes, mode: "dock", key: `new-${Date.now().toString(36)}`, returnHref: "/v2/inbox" });
				return htmlResponse(renderDock(composer));
			}
			const reply = url.searchParams.get("reply");
			if (reply && ID.test(reply)) {
				const mode = url.searchParams.get("mode");
				const draftId = await createReplyDraft(env, user, {
					messageId: reply,
					mode: mode === "all" || mode === "forward" ? mode : "reply",
					mailboxes: (await withSenders(ctx)).mailboxes,
					scopeMailboxIds: ctx.scopeMailboxIds,
					formatDate: (date) => formatFullDate(date, timeZoneOf(ctx)),
				});
				return redirect(draftId ? `/v2/drafts/${draftId}` : "/v2/inbox");
			}
			const draft = url.searchParams.get("draft");
			const page = await renderComposePage(ctx, draft && ID.test(draft) ? draft : null);
			return htmlResponse(page.body, { status: page.status });
		}
		if (name === "headers" && id) {
			const message = await findMessage(ctx, id);
			if (!message) return htmlResponse("Not found", { status: 404 });
			const result = await getMessageHeaderDetailsForUser(env, user, id);
			return htmlResponse(renderDetails(message, result?.details ?? null, result?.hasOriginal ?? false, timeZoneOf(ctx)));
		}
		if (name === "body" && id) {
			const message = await findMessage(ctx, id);
			if (!message) return htmlResponse("Not found", { status: 404 });
			return htmlResponse(renderMessageBody(message));
		}
		if (name === "contacts") return handleContacts(ctx);
		if (name === "poll") {
			const page = await renderRoute(at(ctx, safeReturnPath(url.searchParams.get("path"))));
			return htmlResponse(page.body);
		}
		return htmlResponse((await renderRoute(ctx)).body, { status: 404 });
	}

	if (method !== "POST") return htmlResponse("Method not allowed", { status: 405 });
	const form = await request.formData();
	const name = route.kind === "action" ? route.name : "";
	switch (name) {
		case "act":
			return handleAct(ctx, form);
		case "undo":
			return handleUndo(ctx, form);
		case "unread-from": {
			const messageId = String(form.get("messageId") ?? "");
			const message = await findMessage(ctx, messageId);
			if (message) {
				const thread = await loadThread(env, { messageId, view: "all", scopeMailboxIds: ctx.scopeMailboxIds });
				const from = thread?.messages.findIndex((item) => item.id === messageId) ?? -1;
				if (thread && from >= 0) await markUnreadFrom(env, writeScope(ctx), thread.messages.slice(from).map((item) => item.id));
			}
			return respondWithPage(ctx, String(form.get("return") ?? ""), { push: true });
		}
		case "reply": {
			const messageId = String(form.get("messageId") ?? "");
			const modeValue = String(form.get("mode") ?? "reply");
			const mode = modeValue === "all" || modeValue === "forward" ? modeValue : "reply";
			if (!ID.test(messageId)) return htmlResponse("Not found", { status: 404 });
			const composeCtx = await withSenders(ctx);
			const draftId = await createReplyDraft(env, user, {
				messageId,
				mode,
				mailboxes: composeCtx.mailboxes,
				scopeMailboxIds: ctx.scopeMailboxIds,
				formatDate: (date) => formatFullDate(date, timeZoneOf(ctx)),
			});
			const draft = draftId ? await loadDraft(env, user, draftId) : null;
			if (!draft) return htmlResponse("You can't reply from this mailbox.", { status: 422 });
			const current = safeReturnPath(currentPagePath(request, url));
			return htmlResponse(html`<div id="reply-slot" class="reply-slot">${renderComposer(draft, { mailboxes: composeCtx.mailboxes, mode: "inline", key: draft.id ?? "reply", returnHref: current })}</div>`);
		}
		case "draft": {
			const input = composeInputFrom(form, ctx);
			if ("error" in input) return jsonResponse({ error: input.error }, 422);
			try {
				const id = await saveDraft(env, user, input);
				return id ? jsonResponse({ draftId: id }) : jsonResponse({ error: "This draft was sent or discarded." }, 410);
			} catch (error) {
				return jsonResponse({ error: error instanceof Error ? error.message : "Could not save draft" }, 422);
			}
		}
		case "draft/discard": {
			const draftId = String(form.get("draftId") ?? "");
			if (ID.test(draftId)) await discardDraft(env, user, draftId);
			if (ctx.htmx || request.headers.get("accept")?.includes("application/json")) return jsonResponse({ ok: true });
			return redirect(safeReturnPath(String(form.get("return") ?? ""), "/v2/drafts"));
		}
		case "draft/attachment": {
			const draftId = String(form.get("draftId") ?? "");
			const attachmentId = String(form.get("attachmentId") ?? "");
			const removed = ID.test(draftId) && ID.test(attachmentId) && await removeDraftAttachment(env, user, draftId, attachmentId);
			return jsonResponse({ ok: removed });
		}
		case "send":
			return handleSend(ctx, form);
		case "prefs": {
			const cookies: string[] = [];
			const theme = String(form.get("theme") ?? "");
			if (theme === "light" || theme === "dark" || theme === "system") cookies.push(cookie("mf_theme", theme satisfies V2Theme, url));
			const mailbox = String(form.get("mailbox") ?? "");
			if (mailbox === "all" || ctx.mailboxes.some((item) => item.id === mailbox)) cookies.push(cookie("mf_mb", mailbox, url));
			const back = safeReturnPath(String(form.get("return") ?? ""));
			// Switching mailboxes from a conversation would show an unrelated page; go to its list.
			const route = parseV2Path(new URL(back, url.origin).pathname);
			const location = mailbox && route.kind === "view" ? listHref(route.view === "folder" ? "inbox" : route.view) : back;
			return redirect(location, cookies);
		}
		default:
			return htmlResponse("Not found", { status: 404 });
	}
}
