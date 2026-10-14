import { cx, html, type Html } from "../html";
import { icon } from "../icons";
import { V2_VIEWS, listHref, v2ToClassic } from "../paths";
import type { V2Context, V2Counts, V2Folder, V2ViewKey } from "../types";
import { brandingHeadOf } from "./branding";
import { formatCount } from "./format";

export const ASSET_VERSION = "6";
export const HTMX_VERSION = "2.0.11";

/** The service worker's URL carries the asset versions it precaches (public/sw.js). */
export const SERVICE_WORKER_URL = `/sw.js?v=${ASSET_VERSION}&htmx=${HTMX_VERSION}`;

const HTMX_CONFIG = JSON.stringify({
	includeIndicatorStyles: false,
	allowEval: false,
	allowScriptTags: false,
	historyCacheSize: 0,
	refreshOnHistoryMiss: false,
	selfRequestsOnly: true,
	scrollIntoViewOnBoost: false,
	defaultFocusScroll: false,
	getCacheBusterParam: false,
	globalViewTransitions: false,
});

export type NavState = {
	counts: V2Counts;
	folders: V2Folder[];
	active: { view: V2ViewKey; folderId: string | null };
};

function navCount(value: number, kind: "unread" | "total" = "unread"): Html {
	return value > 0 ? html`<span class="${cx("nav-count", kind === "total" && "is-total")}">${formatCount(value)}</span>` : html``;
}

export function renderNav(ctx: V2Context, nav: NavState): Html {
	const selected = ctx.mailboxes.find((mailbox) => mailbox.id === ctx.selectedMailboxId);
	const items = V2_VIEWS.map((view) => {
		const active = nav.active.view === view.key;
		const count = view.key === "inbox"
			? navCount(nav.counts.inbox)
			: view.key === "spam"
				? navCount(nav.counts.spam)
				: view.key === "drafts"
					? navCount(nav.counts.drafts, "total")
					: html``;
		return html`<a class="${cx("nav-item", active && "is-active", view.key === "inbox" && nav.counts.inbox > 0 && "has-unread")}" href="${listHref(view.key)}" title="${view.label}" ${active ? html`aria-current="page"` : ""}>
			${icon(view.icon)}<span class="nav-label">${view.label}</span>${count}
		</a>`;
	});
	const folders = nav.folders.map((folder) => {
		const active = nav.active.view === "folder" && nav.active.folderId === folder.id;
		return html`<a class="${cx("nav-item", active && "is-active", folder.unread > 0 && "has-unread")}" href="${listHref("folder", { folderId: folder.id })}" title="${folder.name}" ${active ? html`aria-current="page"` : ""}>
			<span class="folder-dot" data-color="${folder.color ?? ""}">${icon("folder")}</span><span class="nav-label">${folder.name}</span>${navCount(folder.unread)}
		</a>`;
	});
	const mailboxSwitcher = ctx.mailboxes.length > 1
		? html`<form class="mailbox-switch" method="post" action="/v2/prefs" hx-boost="false">
				<label class="sr-only" for="mailbox-select">Mailbox</label>
				<select id="mailbox-select" name="mailbox" data-autosubmit>
					<option value="all" ${!ctx.selectedMailboxId ? "selected" : ""}>All mailboxes</option>
					${ctx.mailboxes.map((mailbox) => html`<option value="${mailbox.id}" ${mailbox.id === ctx.selectedMailboxId ? "selected" : ""}>${mailbox.address}</option>`)}
				</select>
				<input type="hidden" name="return" value="${ctx.url.pathname}">
				<noscript><button type="submit">Switch</button></noscript>
			</form>`
		: html`<div class="mailbox-name" title="${ctx.mailboxes[0]?.address ?? ""}">${selected?.address ?? ctx.mailboxes[0]?.address ?? ""}</div>`;
	return html`<nav id="nav" class="sidebar" aria-label="Mail folders">
		<div class="sidebar-top">
			<button type="button" class="compose-button" data-compose title="Compose (c)">${icon("pencil")}<span>Compose</span></button>
			${mailboxSwitcher}
		</div>
		<div class="nav-list">${items}</div>
		${folders.length ? html`<div class="nav-heading">Folders</div><div class="nav-list">${folders}</div>` : ""}
		<div class="sidebar-foot">
			${ctx.vapidPublicKey ? renderPushToggle() : ""}
			<a class="nav-item subtle" href="/settings/account" hx-boost="false" title="Settings">${icon("settings")}<span class="nav-label">Settings</span></a>
			<button type="button" class="nav-item subtle" data-help title="Keyboard shortcuts">${icon("keyboard")}<span class="nav-label">Keyboard shortcuts</span><kbd>?</kbd></button>
			<a class="nav-item subtle" href="${`/v2/switch?to=classic&from=${encodeURIComponent(ctx.url.pathname)}`}" hx-boost="false" title="Switch to classic">${icon("layout")}<span class="nav-label">Switch to classic</span></a>
		</div>
	</nav>`;
}

/**
 * Opt-in for new-mail notifications. Hidden until app.js knows the browser's
 * state (on, off, blocked, or "install first" on iOS) and fills in the label.
 */
function renderPushToggle(): Html {
	return html`<button type="button" class="nav-item subtle push-toggle" data-push hidden>${icon("bell")}<span class="nav-label" data-push-label>Notifications</span></button>`;
}

function themeIcon(theme: V2Context["theme"]): Html {
	return icon(theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor");
}

/** The licensed custom icon fills the mark; the packaged mark is the mail glyph on the accent colour. */
function brandMark(customIcon: string | null): Html {
	return customIcon
		? html`<img class="brand-mark" src="${customIcon}" alt="" width="34" height="34" style="background:none;object-fit:contain">`
		: html`<span class="brand-mark">${icon("mail")}</span>`;
}

export function renderTopbar(ctx: V2Context, q: string): Html {
	const brand = brandingHeadOf(ctx);
	const nextTheme = ctx.theme === "system" ? "light" : ctx.theme === "light" ? "dark" : "system";
	return html`<header id="topbar" class="topbar">
		<button type="button" class="icon-button nav-toggle" data-nav-toggle aria-label="Menu">${icon("menu")}</button>
		<a class="brand" href="/v2/inbox">${brandMark(brand.brandIcon)}<span class="brand-name">${brand.appName}</span></a>
		<form class="search" action="/v2/search" method="get" role="search">
			${icon("search", "icon search-icon")}
			<input type="search" name="q" value="${q}" placeholder="Search mail" aria-label="Search mail" autocomplete="off" spellcheck="false" enterkeyhint="search">
			<kbd class="search-hint">/</kbd>
		</form>
		<div class="offline-banner" data-offline-banner role="status" aria-live="polite" hidden>${icon("cloud-off")}<span data-offline-text>Offline</span></div>
		<div class="topbar-actions">
			<form method="post" action="/v2/prefs" hx-boost="false" class="inline-form">
				<input type="hidden" name="theme" value="${nextTheme}">
				<input type="hidden" name="return" value="${`${ctx.url.pathname}${ctx.url.search}`}">
				<button type="submit" class="icon-button" title="${`Theme: ${ctx.theme} (switch to ${nextTheme})`}" aria-label="Change theme">${themeIcon(ctx.theme)}</button>
			</form>
			<a class="pill-button" href="${`/v2/switch?to=classic&from=${encodeURIComponent(ctx.url.pathname)}`}" hx-boost="false" title="Switch to the classic interface">Classic</a>
			<span class="avatar avatar-me" title="${ctx.user.email}">${(ctx.user.name || ctx.user.email).slice(0, 1).toUpperCase()}</span>
		</div>
	</header>`;
}

/**
 * The whole document. Navigation swaps only #main (and refreshes #nav and
 * #toast out of band), so the composer dock survives moving between views.
 */
export function renderPage(
	ctx: V2Context,
	input: { title: string; main: Html; nav: NavState; q?: string; toast?: Html | null; dock?: Html | null },
): Html {
	const themeAttr = ctx.theme === "system" ? "" : ctx.theme;
	const brand = brandingHeadOf(ctx);
	return html`<!doctype html>
<html lang="en" data-theme="${themeAttr}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111214" media="(prefers-color-scheme: dark)">
<meta name="htmx-config" content="${HTMX_CONFIG}">
<title>${input.title}</title>
<link rel="icon" href="${brand.favicon}">
<link rel="manifest" href="${brand.manifest}">
<link rel="apple-touch-icon" href="${brand.appleTouchIcon}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${brand.appName}">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="stylesheet" href="${`/v2-assets/app.css?v=${ASSET_VERSION}`}">
<script src="${`/v2-assets/htmx.min.js?v=${HTMX_VERSION}`}" defer></script>
<script src="${`/v2-assets/offline.js?v=${ASSET_VERSION}`}" defer></script>
<script src="${`/v2-assets/app.js?v=${ASSET_VERSION}`}" defer></script>
</head>
<body hx-boost="true" hx-target="#main" hx-select="#main" hx-swap="outerHTML" hx-select-oob="#nav,#toast" data-shortcuts="${ctx.shortcutsEnabled ? "on" : "off"}" data-classic-href="${v2ToClassic(ctx.url.pathname)}" data-sw="${SERVICE_WORKER_URL}" data-user="${ctx.user.id}"${ctx.vapidPublicKey ? html` data-vapid-key="${ctx.vapidPublicKey}"` : ""}>
<a class="skip-link" href="#main">Skip to content</a>
<div class="progress" aria-hidden="true"></div>
<datalist id="v2-contacts"></datalist>
<div class="app">
	${renderTopbar(ctx, input.q ?? "")}
	${renderNav(ctx, input.nav)}
	<div class="scrim" data-nav-close></div>
	${input.main}
</div>
<div id="compose-dock" class="compose-dock">${input.dock ?? ""}</div>
${renderToast(input.toast ?? null)}
<button type="button" class="fab" data-compose aria-label="Compose">${icon("pencil")}</button>
</body>
</html>`;
}

export function renderToast(content: Html | null): Html {
	return html`<div id="toast" class="${cx("toast-region", !!content && "has-toast")}" role="status" aria-live="polite">${content ? html`<div class="toast">${content}</div>` : ""}</div>`;
}
