/* Mailflare v2 client. Pages are rendered on the server and swapped by htmx;
   this file adds what HTML alone cannot: Gmail keyboard shortcuts, selection,
   sizing email frames, the composer, and live updates. No build step. */
(() => {
	"use strict";

	const $ = (selector, root = document) => root.querySelector(selector);
	const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
	const body = document.body;
	const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
	const shortcutsOn = () => body.dataset.shortcuts !== "off";

	/* ---------- basics ---------- */

	function setCookie(name, value) {
		document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
	}
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (zone && !document.cookie.includes(`mf_tz=${encodeURIComponent(zone)}`)) {
			setCookie("mf_tz", zone);
			// The first page rendered in UTC; show local times from the start.
			if (!sessionStorage.getItem("mf_tz_reload")) {
				sessionStorage.setItem("mf_tz_reload", "1");
				location.reload();
				return;
			}
		}
	} catch {
		/* Intl unavailable: times stay in UTC. */
	}

	const page = () => $("#main .page");
	const pageKind = () => page()?.dataset.page ?? "";
	const isTyping = (target) => {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable) return true;
		if (target instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(target.type);
		return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
	};

	function toast(message) {
		const region = $("#toast");
		if (!region) return;
		region.innerHTML = "";
		const box = document.createElement("div");
		box.className = "toast";
		const text = document.createElement("span");
		text.textContent = message;
		box.append(text);
		region.append(box);
		region.classList.add("has-toast");
		scheduleToastHide();
	}

	let toastTimer = 0;
	function scheduleToastHide() {
		clearTimeout(toastTimer);
		const region = $("#toast");
		if (!region || !region.querySelector(".toast")) return;
		region.classList.remove("is-leaving");
		toastTimer = setTimeout(() => {
			region.classList.add("is-leaving");
			setTimeout(() => {
				region.innerHTML = "";
				region.classList.remove("has-toast", "is-leaving");
			}, 220);
		}, 9000);
	}

	function formValues(form) {
		const values = {};
		for (const [key, value] of new FormData(form)) {
			if (value instanceof File) continue;
			if (key in values) values[key] = [].concat(values[key], value);
			else values[key] = value;
		}
		return values;
	}

	/** Swap #main with the page a request returns, like a boosted link. */
	function load(verb, path, values) {
		return window.htmx.ajax(verb, path, { target: "#main", select: "#main", swap: "outerHTML", values, source: body });
	}

	function navigate(href) {
		if (!href) return;
		const link = document.createElement("a");
		link.href = href;
		link.style.display = "none";
		$("#main").append(link);
		// Boosting only applies to links htmx has processed.
		window.htmx.process(link);
		link.click();
	}

	/* ---------- loading indicator ---------- */

	document.addEventListener("htmx:beforeRequest", (event) => {
		if (event.detail.elt?.closest?.("[data-composer]") && event.detail.requestConfig?.verb !== "post") return;
		body.classList.add("is-loading");
	});
	document.addEventListener("htmx:afterRequest", () => body.classList.remove("is-loading"));
	document.addEventListener("htmx:responseError", (event) => {
		const raw = event.detail.xhr?.responseText || "Something went wrong.";
		const text = raw.length > 200 ? "Something went wrong." : raw;
		// A refused list action already changed the rows; reload them, then explain.
		if (event.detail.requestConfig?.parameters?.partial === "1") refresh().then(() => toast(text));
		else toast(text);
	});
	document.addEventListener("htmx:sendError", (event) => {
		if (handleOfflineFailure(event.detail)) return;
		toast("You appear to be offline.");
	});

	/* ---------- page setup after every swap ---------- */

	function onPage() {
		closeNav();
		closeMenus();
		updateSelection();
		restoreCursor();
		$$("iframe.mail-frame").forEach(setupFrame);
		scheduleToastHide();
		const kind = pageKind();
		if (kind === "thread") {
			const first = $(".msg.is-unread.is-expanded") ?? $(".msg.is-last");
			if (first && first !== $(".msg")) first.scrollIntoView({ block: "start" });
			messageCursor = Math.max(0, $$(".msg").indexOf(first ?? $$(".msg").at(-1)));
		}
		if (kind === "compose") $("[data-composer] [data-recipients]")?.focus();
	}
	document.addEventListener("DOMContentLoaded", onPage);
	if (document.readyState !== "loading") queueMicrotask(onPage);
	document.addEventListener("htmx:afterSettle", (event) => {
		const target = event.detail.target;
		if (target?.id === "main") onPage();
		else {
			$$("iframe.mail-frame", target).forEach(setupFrame);
			scheduleToastHide();
		}
	});
	document.addEventListener("htmx:load", (event) => {
		$$("[data-composer]", event.detail.elt).concat(event.detail.elt.matches?.("[data-composer]") ? [event.detail.elt] : []).forEach(setupComposer);
		$$("iframe.mail-frame", event.detail.elt).forEach(setupFrame);
	});

	/* ---------- drawer, menus, theme select ---------- */

	function closeNav() {
		body.classList.remove("nav-open");
	}
	function closeMenus(except) {
		$$("details.menu[open]").forEach((menu) => {
			if (menu !== except) menu.open = false;
		});
	}
	document.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		if (target.closest("[data-nav-toggle]")) {
			body.classList.toggle("nav-open");
			return;
		}
		if (target.closest("[data-nav-close]")) closeNav();
		const menu = target.closest("details.menu");
		closeMenus(menu);
		if (target.closest(".menu-item") && menu) setTimeout(() => (menu.open = false), 0);
		if (target.closest("[data-help]")) openHelp();
		if (target.closest("[data-compose]")) openCompose();
	});
	document.addEventListener("change", (event) => {
		const target = event.target;
		if (target instanceof HTMLSelectElement && target.matches("[data-autosubmit]")) target.form?.submit();
	});

	/* ---------- selection and list cursor ---------- */

	const rows = () => $$("[data-row]", page() ?? document);
	let cursor = -1;
	const cursorKey = () => `mf_cursor:${location.pathname}${location.search}`;

	function setCursor(index, scroll = true) {
		const list = rows();
		if (list.length === 0) return;
		cursor = Math.max(0, Math.min(list.length - 1, index));
		list.forEach((row, position) => row.classList.toggle("is-cursor", position === cursor));
		if (scroll) list[cursor].scrollIntoView({ block: "nearest" });
		sessionStorage.setItem(cursorKey(), String(cursor));
	}
	function restoreCursor() {
		const stored = sessionStorage.getItem(cursorKey());
		const saved = stored === null ? -1 : Number(stored);
		cursor = -1;
		if (pageKind() === "list" && Number.isInteger(saved) && saved >= 0 && rows().length) setCursor(Math.min(saved, rows().length - 1), false);
	}
	const cursorRow = () => (cursor >= 0 ? rows()[cursor] : null);

	function selectedIds() {
		return $$("[data-row-check]:checked", page() ?? document).map((input) => input.value);
	}
	function updateSelection() {
		const current = page();
		if (!current || current.dataset.page !== "list") return;
		const checks = $$("[data-row-check]", current);
		let count = 0;
		for (const check of checks) {
			check.closest("[data-row]")?.classList.toggle("is-selected", check.checked);
			if (check.checked) count += 1;
		}
		current.classList.toggle("has-selection", count > 0);
		const counter = $("[data-selected-count]", current);
		if (counter) counter.textContent = count ? `${count} selected` : "";
		const all = $("[data-select-all]", current);
		if (all) {
			all.checked = count > 0 && count === checks.length;
			all.indeterminate = count > 0 && count < checks.length;
		}
	}
	function selectWhere(predicate) {
		for (const check of $$("[data-row-check]", page() ?? document)) check.checked = predicate(check.closest("[data-row]"));
		updateSelection();
	}
	document.addEventListener("change", (event) => {
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;
		if (target.matches("[data-select-all]")) selectWhere(() => target.checked);
		else if (target.matches("[data-row-check]")) updateSelection();
	});

	/* ---------- actions ---------- */

	function listForm() {
		return $("#list-form");
	}

	const REMOVING = new Set(["archive", "trash", "spam", "inbox", "folder"]);

	/** Whether an action takes conversations out of the list being shown. */
	function leavesList(values, view) {
		const action = values.move ? (values.move.startsWith("folder:") ? "folder" : values.move) : values.action;
		if (values.snooze) return view !== "all" && view !== "search" && view !== "starred";
		if (!REMOVING.has(action)) return false;
		if (action === "trash" || action === "spam") return true;
		// Archived or moved mail is still in All mail, search results and Starred.
		if (view === "all" || view === "search" || view === "starred") return false;
		if (action === "inbox") return view !== "inbox";
		return true;
	}

	/**
	 * Run an action on the selection, or on the row under the cursor, the way
	 * Gmail does: the rows change at once and the server only confirms. If it
	 * refuses, the list reloads to show the truth.
	 */
	function actOnList(values, explicitIds) {
		const form = listForm();
		if (!form) return;
		const ids = explicitIds ?? (selectedIds().length ? selectedIds() : [cursorRow()?.dataset.id].filter(Boolean));
		if (!ids.length) return toast("Select a conversation first.");
		const data = formValues(form);
		data.ids = ids;
		data.partial = "1";
		Object.assign(data, values);
		const view = page()?.dataset.view ?? "";
		const affected = rows().filter((row) => ids.includes(row.dataset.id));
		if (leavesList(values, view)) {
			const cursorIndex = cursor;
			affected.forEach((row) => row.remove());
			const remaining = rows();
			if (remaining.length) setCursor(Math.min(Math.max(cursorIndex, 0), remaining.length - 1), false);
		} else if (values.action === "read" || values.action === "unread") {
			affected.forEach((row) => row.classList.toggle("is-unread", values.action === "unread"));
		}
		selectWhere(() => false);
		return window.htmx
			.ajax("POST", "/v2/act", { target: "#toast", select: "#toast", swap: "outerHTML", values: data, source: body })
			.then(() => {
				// Refill a page that has emptied out.
				if (leavesList(values, view) && rows().length < 10 && (page()?.dataset.next || rows().length === 0)) refresh();
			}, () => {
				/* Unreachable: htmx:sendError queued it or said so. */
			});
	}


	// The toolbar and its menus submit the list form; send those through actOnList too.
	document.addEventListener("submit", (event) => {
		const form = event.target;
		if (!(form instanceof HTMLFormElement) || form.id !== "list-form") return;
		const submitter = event.submitter;
		if (!submitter?.name) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const values = { [submitter.name]: submitter.value };
		if (submitter.name === "snooze") values.snoozeAt = form.querySelector("[name=snoozeAt]")?.value ?? $("[name=snoozeAt][form=list-form]")?.value ?? "";
		closeMenus();
		actOnList(values);
	}, true);

	function actOnThread(values) {
		const form = $("#thread-form");
		if (!form) return;
		return load("POST", "/v2/act", Object.assign(formValues(form), values));
	}

	function act(values) {
		if (pageKind() === "thread") return actOnThread(values);
		if (pageKind() === "list") return actOnList(values);
	}

	document.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const rowAction = target?.closest("[data-row-action]");
		if (rowAction) {
			event.preventDefault();
			const row = rowAction.closest("[data-row]");
			if (!row) return;
			actOnList({ action: rowAction.dataset.rowAction }, [row.dataset.id]);
			return;
		}
		const star = target?.closest("[data-star]");
		if (star) {
			event.preventDefault();
			toggleRowStar(star);
		}
	});

	function toggleRowStar(button) {
		const form = listForm();
		if (!form) return;
		const on = !button.classList.contains("is-starred");
		button.classList.toggle("is-starred", on);
		button.setAttribute("aria-pressed", String(on));
		const data = new FormData();
		for (const name of ["view", "folder", "q", "return"]) data.set(name, form.elements[name]?.value ?? "");
		data.set("ids", button.dataset.star);
		data.set("action", on ? "star" : "unstar");
		data.set("quiet", "1");
		fetch("/v2/act", { method: "POST", body: data, headers: { "HX-Request": "true" } }).then((response) => {
			if (!response.ok) {
				button.classList.toggle("is-starred", !on);
				toast("Couldn't update the star.");
			}
		}, () => queueOffline("act", [...data]).then((queued) => {
			if (!queued) {
				button.classList.toggle("is-starred", !on);
				toast("Couldn't update the star.");
			}
		}));
	}

	function openMenu(name) {
		const menu = $(`#main details.menu[data-menu="${name}"]`);
		if (!menu) return false;
		closeMenus(menu);
		menu.open = true;
		($(".menu-item", menu) ?? $("summary", menu))?.focus();
		return true;
	}

	/* ---------- conversations ---------- */

	let messageCursor = 0;
	const messages = () => $$(".msg");

	function expandMessage(section, open = true) {
		if (!section) return;
		section.classList.toggle("is-expanded", open);
		section.classList.toggle("is-collapsed", !open);
		if (open) {
			const lazy = $(".msg-lazy", section);
			if (lazy) window.htmx.trigger(lazy, "msg-expand");
			$$("iframe.mail-frame", section).forEach(sizeFrame);
		}
	}
	function moveMessageCursor(delta) {
		const list = messages();
		if (!list.length) return;
		messageCursor = Math.max(0, Math.min(list.length - 1, messageCursor + delta));
		const section = list[messageCursor];
		section.scrollIntoView({ block: "nearest" });
		$(".msg-head", section)?.focus({ preventScroll: true });
	}

	document.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const head = target?.closest("[data-msg-toggle]");
		if (!head || target.closest("button, a, form, details, input, select, label")) return;
		const section = head.closest(".msg");
		// The newest message stays open, as in Gmail.
		if (section.classList.contains("is-last") && section.classList.contains("is-expanded")) return;
		expandMessage(section, section.classList.contains("is-collapsed"));
		messageCursor = messages().indexOf(section);
	});

	document.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const toggle = target?.closest("[data-details]");
		if (!toggle) return;
		const panel = document.getElementById(`details-${toggle.dataset.details}`);
		// The first click loads the panel through htmx; later clicks show and hide it.
		if (panel && panel.childElementCount > 0) panel.hidden = !panel.hidden;
	});

	/* ---------- email frames ---------- */

	const QUOTE_SELECTORS = [".gmail_quote", "blockquote[type=cite]", ".yahoo_quoted", "#divRplyFwdMsg", "#appendonsend", "[data-mailflare-quote]", ".mailflare-quote", ".moz-cite-prefix"];

	function sizeFrame(frame) {
		try {
			const doc = frame.contentDocument;
			if (!doc?.body) return;
			// The body, not the document: a document is never shorter than its frame.
			const style = doc.defaultView.getComputedStyle(doc.body);
			const height = doc.body.scrollHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
			if (height > 0) frame.style.height = `${Math.ceil(height) + 2}px`;
		} catch {
			/* Not same-origin: leave the default height. */
		}
	}

	function foldQuote(frame) {
		const doc = frame.contentDocument;
		if (!doc?.body || frame.dataset.folded) return;
		frame.dataset.folded = "1";
		const quote = QUOTE_SELECTORS.map((selector) => doc.querySelector(selector)).find(Boolean);
		if (!quote) return;
		// Only fold when there is something above the quote to read.
		const before = doc.body.innerText.split(quote.innerText)[0]?.trim() ?? "";
		if (!before) return;
		let node = quote;
		if (quote.matches("#divRplyFwdMsg, #appendonsend")) {
			const hidden = [];
			while (node) {
				hidden.push(node);
				node = node.nextElementSibling;
			}
			hidden.forEach((element) => element.classList.add("mf-quote-hidden"));
		} else {
			quote.classList.add("mf-quote-hidden");
		}
		const button = document.createElement("button");
		button.type = "button";
		button.className = "quote-toggle";
		button.textContent = "•••";
		button.title = "Show trimmed content";
		button.setAttribute("aria-label", "Show trimmed content");
		button.addEventListener("click", () => {
			const elements = doc.querySelectorAll(".mf-quote-hidden, [data-mf-quote-shown]");
			elements.forEach((element) => {
				const shown = element.hasAttribute("data-mf-quote-shown");
				element.classList.toggle("mf-quote-hidden", shown);
				element.toggleAttribute("data-mf-quote-shown", !shown);
			});
			sizeFrame(frame);
		});
		frame.after(button);
	}

	function setupFrame(frame) {
		if (frame.dataset.ready) return;
		frame.dataset.ready = "1";
		const ready = () => {
			foldQuote(frame);
			sizeFrame(frame);
			try {
				const doc = frame.contentDocument;
				if (doc?.body && "ResizeObserver" in window) new ResizeObserver(() => sizeFrame(frame)).observe(doc.body);
				doc?.querySelectorAll("img").forEach((image) => image.addEventListener("load", () => sizeFrame(frame)));
			} catch {
				/* ignore */
			}
		};
		// Size as soon as the body is parsed; "load" waits for every remote image.
		let started = false;
		const start = () => {
			if (started) return sizeFrame(frame);
			const doc = frame.contentDocument;
			if (!doc?.body || doc.URL === "about:blank" || doc.readyState === "loading") return false;
			started = true;
			ready();
			return true;
		};
		frame.addEventListener("load", start);
		let tries = 0;
		const poll = () => {
			if (start() === true || started || ++tries > 200) return;
			setTimeout(poll, 25);
		};
		poll();
	}
	window.addEventListener("resize", () => $$("iframe.mail-frame").forEach(sizeFrame));

	/* ---------- touch: sheets, swipe, pull to refresh, recipients, split pane ---------- */

	/* pure:start (DOM-free; tests/v2-touch.test.mjs runs this block on its own) */

	/** The action a horizontal swipe commits to, or null to snap the row back. */
	function swipeOutcome(dx, width, actions) {
		const action = dx > 0 ? actions.right : actions.left;
		if (!action || !width) return null;
		return Math.abs(dx) >= width * 0.35 ? action : null;
	}

	/** Split typed recipients into finished entries and the part still being typed. */
	function splitRecipients(text) {
		const done = [];
		let current = "";
		let quoted = false;
		let angle = false;
		for (const char of text) {
			if (char === "\"") quoted = !quoted;
			else if (char === "<" && !quoted) angle = true;
			else if (char === ">" && !quoted) angle = false;
			if ((char === "," || char === ";") && !quoted && !angle) {
				if (current.trim()) done.push(current.trim());
				current = "";
				continue;
			}
			current += char;
		}
		return { done, rest: current.replace(/^\s+/, "") };
	}

	/** A finished address: a bare email, or a display name with an address in angle brackets. */
	function isCompleteAddress(text) {
		const value = text.trim();
		return /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(value) || /<[^\s@<>]+@[^\s@<>]+>$/.test(value);
	}

	/** The name and address to show for one recipient entry. */
	function parseRecipient(text) {
		const match = text.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
		if (match) return { name: match[1].trim(), email: match[2].trim() };
		return { name: "", email: text.trim() };
	}

	/* pure:end */

	const coarsePointer = window.matchMedia("(pointer: coarse)");
	const narrowScreen = window.matchMedia("(max-width: 899px)");
	const tabletBand = window.matchMedia("(min-width: 900px) and (max-width: 1199px)");

	function onTouchPage() {
		setupPullToRefresh();
		setupSplitList();
		setupRecipientChips(document);
	}
	document.addEventListener("DOMContentLoaded", onTouchPage);
	if (document.readyState !== "loading") queueMicrotask(onTouchPage);
	document.addEventListener("htmx:afterSettle", (event) => {
		if (event.detail.target?.id === "main") onTouchPage();
	});
	document.addEventListener("htmx:load", (event) => setupRecipientChips(event.detail.elt));
	tabletBand.addEventListener("change", () => setupSplitList());

	// The scrim under a details sheet closes it; menus already close on any outside click.
	document.addEventListener("click", (event) => {
		if (!narrowScreen.matches || !(event.target instanceof Element) || !event.target.closest(".scrim")) return;
		$$("#main .msg-details:not([hidden])").forEach((panel) => (panel.hidden = true));
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || !narrowScreen.matches) return;
		const open = $$("#main .msg-details:not([hidden])");
		if (!open.length) return;
		open.forEach((panel) => (panel.hidden = true));
		event.stopImmediatePropagation();
	}, true);

	/* Swipe a list row right to archive (or move back to the Inbox) and left to delete,
	   using the same actions as the row's hover buttons, so each view keeps its rules. */

	const SWIPE_LABELS = { archive: "Archive", inbox: "Move to Inbox", trash: "Delete" };
	let swipe = null;
	let swallowClickUntil = 0;

	function rowSwipeActions(row) {
		const actions = $$(".row-hover [data-row-action]", row).map((button) => button.dataset.rowAction);
		return {
			right: actions.find((action) => action === "archive" || action === "inbox") ?? null,
			left: actions.includes("trash") ? "trash" : null,
		};
	}

	function paintSwipe(row, dx, action) {
		row.classList.add("is-swiping");
		row.style.transform = `translateX(${dx}px)`;
		row.style.setProperty("--swipe-x", `${dx}px`);
		row.dataset.swipeDir = dx > 0 ? "right" : "left";
		row.dataset.swipeAction = action ?? "";
		row.dataset.swipeLabel = SWIPE_LABELS[action] ?? "";
	}

	function clearSwipe(row) {
		row.classList.remove("is-swiping", "is-armed", "is-settling");
		row.style.removeProperty("transform");
		row.style.removeProperty("--swipe-x");
		delete row.dataset.swipeDir;
		delete row.dataset.swipeAction;
		delete row.dataset.swipeLabel;
	}

	document.addEventListener("touchstart", (event) => {
		swipe = null;
		if (event.touches.length !== 1 || pageKind() !== "list" || !(event.target instanceof Element)) return;
		const row = event.target.closest("#main .page [data-row]");
		if (!row || event.target.closest(".row-hover")) return;
		const actions = rowSwipeActions(row);
		if (!actions.left && !actions.right) return;
		const touch = event.touches[0];
		swipe = { row, actions, x: touch.clientX, y: touch.clientY, dx: 0, axis: null, width: row.offsetWidth };
	}, { passive: true });

	document.addEventListener("touchmove", (event) => {
		if (!swipe || event.touches.length !== 1) return;
		const touch = event.touches[0];
		const dx = touch.clientX - swipe.x;
		const dy = touch.clientY - swipe.y;
		if (!swipe.axis) {
			if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
			swipe.axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? "x" : "y";
		}
		if (swipe.axis !== "x") return;
		const action = dx > 0 ? swipe.actions.right : swipe.actions.left;
		// A direction with nothing to do only gives a little, then stops.
		swipe.dx = action ? dx : Math.max(-24, Math.min(24, dx / 4));
		paintSwipe(swipe.row, swipe.dx, action);
		swipe.row.classList.toggle("is-armed", swipeOutcome(swipe.dx, swipe.width, swipe.actions) !== null);
	}, { passive: true });

	function endSwipe() {
		const current = swipe;
		swipe = null;
		if (!current || current.axis !== "x") return;
		const { row, dx, width } = current;
		swallowClickUntil = Date.now() + 400;
		const action = swipeOutcome(dx, width, current.actions);
		row.classList.add("is-settling");
		if (action) {
			paintSwipe(row, dx > 0 ? width : -width, action);
			setTimeout(() => {
				actOnList({ action }, [row.dataset.id]);
				// Views where the conversation stays (All mail, Starred) get the row back.
				if (row.isConnected) clearSwipe(row);
			}, 180);
		} else {
			paintSwipe(row, 0, null);
			setTimeout(() => clearSwipe(row), 200);
		}
	}
	document.addEventListener("touchend", endSwipe, { passive: true });
	document.addEventListener("touchcancel", endSwipe, { passive: true });

	// A swipe must not also open the conversation.
	document.addEventListener("click", (event) => {
		if (Date.now() > swallowClickUntil || !(event.target instanceof Element) || !event.target.closest("[data-row]")) return;
		event.preventDefault();
		event.stopPropagation();
	}, true);

	/* Pull a list down from the top to reload it. The list scrolls inside a fixed shell,
	   so the browser's own pull-to-refresh never fires. */

	const PULL_TRIGGER = 64;

	function setupPullToRefresh() {
		const list = $("#main .page[data-page=list] .list");
		if (!list || list.dataset.ptr || !coarsePointer.matches) return;
		list.dataset.ptr = "1";
		let start = null;
		let pull = 0;
		let indicator = null;
		const setPull = (value) => {
			pull = value;
			if (!indicator) {
				indicator = document.createElement("div");
				indicator.className = "ptr";
				indicator.setAttribute("aria-hidden", "true");
				const glyph = $("#main .toolbar a[aria-label=Refresh] svg");
				if (glyph) indicator.append(glyph.cloneNode(true));
				list.prepend(indicator);
			}
			list.classList.toggle("is-pulling", value > 0);
			list.style.setProperty("--ptr", `${value}px`);
			indicator.classList.toggle("is-armed", value >= PULL_TRIGGER);
		};
		list.addEventListener("touchstart", (event) => {
			start = list.scrollTop <= 0 && event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
		}, { passive: true });
		list.addEventListener("touchmove", (event) => {
			if (!start) return;
			// A row swipe won this gesture: let go of the pull entirely.
			if (swipe?.axis === "x") {
				if (pull) setPull(0);
				start = null;
				return;
			}
			const dy = event.touches[0].clientY - start.y;
			const dx = event.touches[0].clientX - start.x;
			if (pull === 0) {
				if (dy < 0 || list.scrollTop > 0) start = null;
				// Same axis rule as the swipe, so a diagonal drag is one gesture or the other.
				if (!start || dy < 10 || dy <= Math.abs(dx) * 1.3) return;
			}
			event.preventDefault();
			setPull(Math.max(0, Math.min(96, (dy - 10) * 0.5)));
		}, { passive: false });
		const release = () => {
			if (!start) return;
			start = null;
			if (pull < PULL_TRIGGER) return setPull(0);
			indicator.classList.add("is-refreshing");
			setPull(PULL_TRIGGER);
			// The reload swaps the list out; if it fails, put the list back.
			Promise.resolve(refresh()).finally(() => {
				if (!list.isConnected) return;
				indicator.classList.remove("is-refreshing");
				setPull(0);
			});
		};
		list.addEventListener("touchend", release, { passive: true });
		list.addEventListener("touchcancel", release, { passive: true });
	}

	/* On the tablet band a conversation opens beside its list. The thread page does not
	   carry the list, so fetch it (cached per list URL) into a pane beside the page. */

	const splitLists = new Map();

	function markCurrentRow(pane, scroll) {
		let current = null;
		for (const row of $$("[data-row]", pane)) {
			const here = new URL(row.dataset.href, location.href).pathname === location.pathname;
			row.classList.toggle("is-current", here);
			if (here) current = row;
		}
		if (scroll && current && (current.offsetTop < pane.scrollTop || current.offsetTop + current.offsetHeight > pane.scrollTop + pane.clientHeight)) {
			pane.scrollTop = current.offsetTop - pane.clientHeight / 3;
		}
	}

	async function setupSplitList() {
		const main = $("#main");
		const current = page();
		if (!main || current?.dataset.page !== "thread" || !tabletBand.matches) return;
		const href = current.dataset.list;
		if (!href || $(":scope > .split-list", main)) return;
		const pane = document.createElement("aside");
		pane.className = "split-list";
		pane.setAttribute("aria-label", "Conversations");
		main.prepend(pane);
		let shown = false;
		const show = (markup) => {
			pane.innerHTML = markup;
			window.htmx.process(pane);
			markCurrentRow(pane, !shown);
			shown = true;
		};
		if (splitLists.has(href)) show(splitLists.get(href));
		try {
			const response = await fetch(href, { headers: { Accept: "text/html" } });
			if (!response.ok) return;
			const doc = new DOMParser().parseFromString(await response.text(), "text/html");
			const list = doc.querySelector("#main .rows");
			if (!list) return;
			// The pane only opens conversations; selection, stars and row actions stay on the list page.
			list.querySelectorAll(".row-select, .row-star, .row-hover").forEach((element) => element.remove());
			splitLists.set(href, list.outerHTML);
			if (pane.isConnected) show(list.outerHTML);
		} catch {
			/* The pane is a convenience; the thread works without it. */
		}
	}

	/* Recipient chips on touch screens: finished addresses become chips, and contact
	   suggestions open as a tappable list under the field instead of a datalist that
	   on-screen keyboards hide. A hidden input keeps the field's name, so drafts,
	   sending and validation read the same comma-separated value as before. */

	let contactObserver = null;

	function setupRecipientChips(root) {
		if (!coarsePointer.matches || !(root instanceof Element || root instanceof Document)) return;
		$$("[data-composer] input[data-recipients]", root).forEach(enhanceRecipients);
		const datalist = $("#v2-contacts");
		if (datalist && !contactObserver) {
			// suggestContacts fills the shared datalist; mirror it for the focused field.
			contactObserver = new MutationObserver(() => document.activeElement?.recipientSuggest?.(datalist));
			contactObserver.observe(datalist, { childList: true });
		}
	}

	function enhanceRecipients(input) {
		if (input.dataset.chips || !input.name) return;
		input.dataset.chips = "1";
		const field = input.closest(".cmp-field");
		const form = input.form;
		const hidden = document.createElement("input");
		hidden.type = "hidden";
		hidden.name = input.name;
		input.removeAttribute("name");
		input.removeAttribute("list");
		input.required = false;
		const chips = document.createElement("span");
		chips.className = "rcpt-chips";
		const suggest = document.createElement("ul");
		suggest.className = "rcpt-suggest";
		suggest.setAttribute("role", "listbox");
		suggest.hidden = true;
		input.before(chips);
		input.after(hidden);
		field?.append(suggest);
		const removeGlyph = $("[data-cmp-close] svg", form);
		const addresses = splitRecipients(`${input.value},`).done;
		input.value = "";

		const sync = () => {
			hidden.value = [...addresses, input.value.trim()].filter(Boolean).join(", ");
		};
		const render = () => {
			chips.replaceChildren(...addresses.map((address, index) => {
				const { name, email } = parseRecipient(address);
				const chip = document.createElement("span");
				chip.className = "rcpt-chip";
				chip.title = email;
				const label = document.createElement("span");
				label.textContent = name || email;
				const remove = document.createElement("button");
				remove.type = "button";
				remove.className = "rcpt-remove";
				remove.setAttribute("aria-label", `Remove ${name || email}`);
				if (removeGlyph) remove.append(removeGlyph.cloneNode(true));
				else remove.textContent = "×";
				remove.addEventListener("click", () => {
					addresses.splice(index, 1);
					changed();
					input.focus();
				});
				chip.append(label, remove);
				return chip;
			}));
			sync();
		};
		// Let the composer's own listeners (autosave) see every change.
		const changed = () => {
			render();
			input.dispatchEvent(new Event("input", { bubbles: true }));
		};
		const hideSuggestions = () => {
			suggest.hidden = true;
			suggest.replaceChildren();
		};
		const take = (text) => {
			addresses.push(text.trim());
			input.value = "";
			hideSuggestions();
			changed();
		};
		input.recipientSuggest = (datalist) => {
			const typed = input.value.trim();
			const options = Array.from(datalist.options).map((option) => option.value).filter((value) => value && !addresses.includes(value));
			if (typed.length < 2 || !options.length) return hideSuggestions();
			suggest.replaceChildren(...options.slice(0, 8).map((value) => {
				const { name, email } = parseRecipient(value);
				const item = document.createElement("li");
				item.setAttribute("role", "option");
				const button = document.createElement("button");
				button.type = "button";
				button.className = "rcpt-option";
				const title = document.createElement("span");
				title.textContent = name || email;
				button.append(title);
				if (name) {
					const detail = document.createElement("small");
					detail.textContent = email;
					button.append(detail);
				}
				// Keep focus (and the keyboard) in the field while a suggestion is tapped.
				button.addEventListener("pointerdown", (event) => event.preventDefault());
				button.addEventListener("click", () => {
					take(value);
					input.focus();
				});
				item.append(button);
				return item;
			}));
			suggest.hidden = false;
		};

		input.addEventListener("input", (event) => {
			if (!event.isTrusted) return sync();
			const { done, rest } = splitRecipients(input.value);
			if (done.length) {
				addresses.push(...done);
				input.value = rest;
				render();
			} else {
				sync();
			}
			if (input.value.trim().length < 2) hideSuggestions();
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				// Enter would submit the form, which sends the message.
				event.preventDefault();
				if (input.value.trim()) take(input.value);
				else $("[data-cmp-subject]", form)?.focus();
			} else if (event.key === "Backspace" && !input.value && addresses.length) {
				event.preventDefault();
				input.value = addresses.pop();
				changed();
			}
		});
		input.addEventListener("blur", () => {
			hideSuggestions();
			if (isCompleteAddress(input.value)) take(input.value);
		});
		render();
	}

	/* The on-screen keyboard covers the bottom of the layout viewport on iOS; expose its
	   height as --kb so the composer keeps Send above it. Chrome resizes the page itself
	   (interactive-widget=resizes-content), so there the inset stays 0. */

	function trackKeyboard() {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const update = () => {
			const inset = viewport.scale > 1.01 ? 0 : Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
			document.documentElement.style.setProperty("--kb", `${inset}px`);
		};
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		update();
	}
	trackKeyboard();

	/* ---------- composer ---------- */

	function openCompose(href) {
		if (href) {
			window.open(href, "_blank", "noopener");
			return;
		}
		const existing = $("#compose-dock [data-composer]");
		if (existing) {
			existing.classList.remove("is-minimized");
			$("[data-recipients]", existing)?.focus();
			return;
		}
		// The docked composer comes from the server; offline, the full-page one is cached.
		if (!navigator.onLine) {
			location.href = new URL("/v2/compose", location.href).href;
			return;
		}
		window.htmx.ajax("GET", "/v2/compose/new", { target: "#compose-dock", select: "#compose-dock", swap: "outerHTML", source: body }).then(() => {
			$("#compose-dock [data-recipients]")?.focus();
		});
	}

	function composerData(form, withFiles) {
		const editor = $("[data-editor]", form);
		const html = $("[data-html]", form);
		if (editor && html) html.value = editor.innerHTML;
		const data = new FormData(form);
		if (!withFiles) data.delete("attachments");
		return data;
	}

	function setState(form, text) {
		const state = $("[data-cmp-state]", form);
		if (state) state.textContent = text;
	}

	async function saveDraft(form) {
		if (form.dataset.closed) return;
		const editor = $("[data-editor]", form);
		const hasContent = ["to", "cc", "bcc", "subject"].some((name) => form.elements[name]?.value.trim()) || (editor?.innerText.trim() ?? "") !== "";
		if (!hasContent && !form.elements.draftId.value) return;
		setState(form, "Saving…");
		const data = composerData(form, false);
		// The device copy is written first and kept until the server has the draft.
		await withOutboxLock(async () => {
			const local = await keepDraftOnDevice(form, data);
			try {
				const response = await fetch("/v2/draft", { method: "POST", body: data, headers: { Accept: "application/json", "X-Mailflare-User": body.dataset.user ?? "" } });
				const result = await response.json();
				await forgetOnDevice(local);
				if (response.ok && result.draftId) {
					form.elements.draftId.value = result.draftId;
					setState(form, "Saved");
				} else {
					setState(form, result.error ?? "Not saved");
				}
			} catch {
				setState(form, local ? "Saved on this device" : "Offline – not saved");
				if (local) requestOutboxSync();
			}
		});
	}

	function closeComposer(form, { save = true } = {}) {
		const finish = () => {
			form.dataset.closed = "1";
			const mode = form.dataset.mode;
			if (mode === "dock") form.remove();
			else if (mode === "inline") load("GET", `${location.pathname}${location.search}`);
			else navigate(form.elements.return?.value || "/v2/inbox");
		};
		if (save) saveDraft(form).finally(finish);
		else finish();
	}

	function exec(command, value) {
		document.execCommand(command, false, value);
	}

	function format(form, command) {
		const editor = $("[data-editor]", form);
		editor?.focus();
		switch (command) {
			case "createLink": {
				const url = prompt("Link address");
				if (url && /^(https?:|mailto:)/i.test(url.trim())) exec("createLink", url.trim());
				break;
			}
			case "blockquote":
				exec("formatBlock", "blockquote");
				break;
			default:
				exec(command);
		}
		form.dispatchEvent(new Event("input", { bubbles: true }));
	}

	const FONTS = ["sans-serif", "serif", "monospace", "Georgia", "Verdana"];
	function cycleFont(delta) {
		const current = document.queryCommandValue("fontName").replace(/["']/g, "") || FONTS[0];
		const index = FONTS.findIndex((font) => current.toLowerCase().includes(font.toLowerCase()));
		exec("fontName", FONTS[(index + delta + FONTS.length) % FONTS.length]);
	}
	function stepSize(delta) {
		const current = Number(document.queryCommandValue("fontSize")) || 3;
		exec("fontSize", String(Math.max(1, Math.min(7, current + delta))));
	}

	async function suggestContacts(input) {
		const tokens = input.value.split(",");
		const last = tokens.pop().trim();
		if (last.length < 2) return;
		try {
			const response = await fetch(`/v2/contacts?q=${encodeURIComponent(last)}`);
			const { contacts = [] } = await response.json();
			const list = $("#v2-contacts");
			if (!list) return;
			list.innerHTML = "";
			const prefix = tokens.length ? `${tokens.map((token) => token.trim()).filter(Boolean).join(", ")}, ` : "";
			for (const contact of contacts) {
				const option = document.createElement("option");
				option.value = `${prefix}${contact.name ? `${contact.name} <${contact.email}>` : contact.email}`;
				list.append(option);
			}
		} catch {
			/* suggestions are optional */
		}
	}

	function setupComposer(form) {
		if (form.dataset.ready) return;
		form.dataset.ready = "1";
		restoreDraftFromDevice(form);
		let timer = 0;
		const schedule = () => {
			clearTimeout(timer);
			setState(form, "");
			timer = setTimeout(() => saveDraft(form), 1200);
		};
		form.addEventListener("input", (event) => {
			if (event.target.matches?.("[data-recipients]")) suggestContacts(event.target);
			schedule();
		});
		form.addEventListener("change", (event) => {
			const target = event.target;
			if (target.matches("[data-cmp-from]")) {
				const custom = $("[data-cmp-custom-from]", form);
				const isCustom = target.value.endsWith("|*");
				custom.hidden = !isCustom;
				if (isCustom) custom.focus();
			}
			if (target.matches("[data-cmp-attach]")) showPendingFiles(form, target);
			if (!target.matches("[data-cmp-attach]")) schedule();
		});
		form.addEventListener("click", (event) => {
			const target = event.target instanceof Element ? event.target : null;
			if (!target) return;
			const show = target.closest("[data-cmp-show]");
			if (show) {
				const row = $(`[data-cmp-row="${show.dataset.cmpShow}"]`, form);
				row.hidden = false;
				show.hidden = true;
				$("input", row)?.focus();
			}
			const formatButton = target.closest("[data-format]");
			if (formatButton) format(form, formatButton.dataset.format);
			if (target.closest("[data-cmp-close]")) closeComposer(form);
			if (target.closest("[data-cmp-minimize]") || (form.dataset.mode === "dock" && target.closest(".cmp-head") && !target.closest("button"))) {
				form.classList.toggle("is-minimized");
			}
			if (target.closest("[data-cmp-discard]")) discard(form);
			const remove = target.closest("[data-remove-attachment]");
			if (remove) removeStoredAttachment(form, remove);
		});
		form.addEventListener("submit", (event) => {
			const editor = $("[data-editor]", form);
			$("[data-html]", form).value = editor ? editor.innerHTML : "";
			if (!form.elements.to.value.trim()) {
				event.preventDefault();
				event.stopImmediatePropagation();
				toast("Add at least one recipient.");
				form.elements.to.focus();
				return;
			}
			if (form.dataset.mode === "dock") form.elements.return.value = `${location.pathname}${location.search}`;
			clearTimeout(timer);
			form.dataset.closed = "1";
			setState(form, "Sending…");
		}, true);
		form.addEventListener("htmx:afterRequest", (event) => {
			if (event.detail.elt !== form) return;
			if (event.detail.successful) {
				if (form.dataset.mode === "dock") form.remove();
			} else {
				delete form.dataset.closed;
				setState(form, "Not sent");
			}
		});
	}

	function showPendingFiles(form, input) {
		const box = $("[data-cmp-files]", form);
		$$("[data-pending-file]", box).forEach((chip) => chip.remove());
		for (const file of input.files) {
			const chip = document.createElement("span");
			chip.className = "file-chip";
			chip.dataset.pendingFile = "1";
			const name = document.createElement("span");
			name.textContent = file.name;
			const size = document.createElement("small");
			size.textContent = file.size < 1048576 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / 1048576).toFixed(1)} MB`;
			chip.append(name, size);
			box.append(chip);
		}
	}

	async function removeStoredAttachment(form, button) {
		const data = new FormData();
		data.set("draftId", form.elements.draftId.value);
		data.set("attachmentId", button.dataset.removeAttachment);
		const response = await fetch("/v2/draft/attachment", { method: "POST", body: data });
		if (response.ok) button.closest(".file-chip")?.remove();
	}

	async function discard(form) {
		form.dataset.closed = "1";
		const draftId = form.elements.draftId.value;
		if (draftId) {
			const data = new FormData();
			data.set("draftId", draftId);
			await fetch("/v2/draft/discard", { method: "POST", body: data, headers: { Accept: "application/json" } });
		}
		toast("Draft discarded.");
		closeComposer(form, { save: false });
	}

	function activeComposer() {
		return document.activeElement?.closest?.("[data-composer]") ?? null;
	}

	/** Shortcuts inside the composer (⌘ on Mac, Ctrl elsewhere). */
	function composerKey(event, form) {
		const mod = isMac ? event.metaKey : event.ctrlKey;
		if (event.key === "Escape") {
			event.preventDefault();
			if (form.dataset.mode === "dock") form.classList.add("is-minimized");
			document.activeElement?.blur();
			return true;
		}
		if (!mod) return false;
		const code = event.code;
		const shift = event.shiftKey;
		const run = (fn) => {
			event.preventDefault();
			fn();
			return true;
		};
		if (event.key === "Enter") return run(() => form.requestSubmit($("[data-cmp-send]", form)));
		if (shift && code === "KeyC") return run(() => $('[data-cmp-show="cc"]', form)?.click() ?? $('[name="cc"]', form)?.focus());
		if (shift && code === "KeyB") return run(() => $('[data-cmp-show="bcc"]', form)?.click() ?? $('[name="bcc"]', form)?.focus());
		if (shift && code === "KeyF") return run(() => $("[data-cmp-from]", form)?.focus());
		const inEditor = document.activeElement?.matches?.("[data-editor]");
		if (!inEditor) return false;
		if (!shift && code === "KeyK") return run(() => format(form, "createLink"));
		if (shift && code === "Digit7") return run(() => format(form, "insertOrderedList"));
		if (shift && code === "Digit8") return run(() => format(form, "insertUnorderedList"));
		if (shift && code === "Digit9") return run(() => format(form, "blockquote"));
		if (shift && code === "Digit5") return run(() => cycleFont(-1));
		if (shift && code === "Digit6") return run(() => cycleFont(1));
		if (shift && code === "Minus") return run(() => stepSize(-1));
		if (shift && code === "Equal") return run(() => stepSize(1));
		if (!shift && code === "BracketLeft") return run(() => format(form, "outdent"));
		if (!shift && code === "BracketRight") return run(() => format(form, "indent"));
		if (shift && code === "KeyL") return run(() => format(form, "justifyLeft"));
		if (shift && code === "KeyE") return run(() => format(form, "justifyCenter"));
		if (shift && code === "KeyR") return run(() => format(form, "justifyRight"));
		if (!shift && code === "Backslash") return run(() => format(form, "removeFormat"));
		return false;
	}

	/* ---------- keyboard ---------- */

	const NOT_YET = (what) => () => toast(`${what} isn't available in Mailflare yet.`);

	function reply(mode, newWindow) {
		const latest = page()?.dataset.latest;
		const section = messages()[messageCursor];
		const id = section?.dataset.id ?? latest;
		if (!id) return;
		if (newWindow) return openCompose(`/v2/compose?reply=${encodeURIComponent(id)}&mode=${mode}`);
		const button = $(`#reply-slot [data-reply="${mode}"]`);
		if (button) button.click();
		else if (section) window.htmx.ajax("POST", "/v2/reply", { target: "#reply-slot", select: "#reply-slot", swap: "outerHTML", values: { messageId: id, mode }, source: body });
	}

	function goPage(direction) {
		const href = page()?.dataset[direction];
		if (href) navigate(href);
	}

	function refresh() {
		if (!navigator.onLine) return Promise.resolve();
		return load("GET", `${location.pathname}${location.search}`);
	}

	function undo() {
		if (!navigator.onLine) return toast("Undo needs a connection.");
		const button = $("#toast [data-undo]");
		if (button) button.click();
		else toast("Nothing to undo.");
	}

	/** context: "any", "list", "thread". Keys are KeyboardEvent.key, "Shift+X" for capitals. */
	const KEYMAP = [
		{ group: "Compose & chat", keys: "p", label: "Previous message in an open conversation", context: "thread", run: () => moveMessageCursor(-1) },
		{ group: "Compose & chat", keys: "n", label: "Next message in an open conversation", context: "thread", run: () => moveMessageCursor(1) },
		{ group: "Compose & chat", keys: "Shift+Escape", label: "Focus main window", context: "any", run: () => { document.activeElement?.blur(); $("#main")?.focus(); } },
		{ group: "Compose & chat", keys: "Escape", label: "Focus latest compose / close menus", context: "any", run: escape },
		{ group: "Compose & chat", keys: `${isMac ? "⌘" : "Ctrl"}+Enter`, label: "Send", context: "help" },
		{ group: "Compose & chat", keys: `${isMac ? "⌘" : "Ctrl"}+Shift+c`, label: "Add cc recipients", context: "help" },
		{ group: "Compose & chat", keys: `${isMac ? "⌘" : "Ctrl"}+Shift+b`, label: "Add bcc recipients", context: "help" },
		{ group: "Compose & chat", keys: `${isMac ? "⌘" : "Ctrl"}+Shift+f`, label: "Access custom from", context: "help" },
		{ group: "Compose & chat", keys: `${isMac ? "⌘" : "Ctrl"}+k`, label: "Insert a link", context: "help" },
		{ group: "Formatting text", keys: `${isMac ? "⌘" : "Ctrl"}+Shift+5 / 6`, label: "Previous / next font", context: "help" },
		{ group: "Formatting text", keys: `${isMac ? "⌘" : "Ctrl"}+Shift+- / +`, label: "Decrease / increase text size", context: "help" },
		{ group: "Formatting text", keys: `${isMac ? "⌘" : "Ctrl"}+b / i / u`, label: "Bold / italics / underline", context: "help" },
		{ group: "Formatting text", keys: `${isMac ? "⌘" : "Ctrl"}+Shift+7 / 8`, label: "Numbered / bulleted list", context: "help" },
		{ group: "Formatting text", keys: `${isMac ? "⌘" : "Ctrl"}+Shift+9`, label: "Quote", context: "help" },
		{ group: "Formatting text", keys: `${isMac ? "⌘" : "Ctrl"}+[ / ]`, label: "Indent less / more", context: "help" },
		{ group: "Formatting text", keys: `${isMac ? "⌘" : "Ctrl"}+Shift+l / e / r`, label: "Align left / center / right", context: "help" },
		{ group: "Formatting text", keys: `${isMac ? "⌘" : "Ctrl"}+\\`, label: "Remove formatting", context: "help" },
		{ group: "Actions", keys: ",", label: "Move focus to toolbar", context: "any", run: () => $("#main .toolbar a, #main .toolbar button, #main .toolbar summary")?.focus() },
		{ group: "Actions", keys: "x", label: "Select conversation", context: "list", run: () => { const check = cursorRow()?.querySelector("[data-row-check]"); if (check) { check.checked = !check.checked; updateSelection(); } } },
		{ group: "Actions", keys: "s", label: "Toggle star", context: "list", run: () => { const button = cursorRow()?.querySelector("[data-star]"); if (button) toggleRowStar(button); } },
		{ group: "Actions", keys: "s", label: "Toggle star", context: "thread", hidden: true, run: () => $("#main .star-button")?.click() },
		{ group: "Actions", keys: "e", label: "Archive", context: "any", run: () => act({ action: "archive" }) },
		{ group: "Actions", keys: "y", label: "Archive", context: "any", hidden: true, run: () => act({ action: "archive" }) },
		{ group: "Actions", keys: "m", label: "Mute conversation", context: "any", run: NOT_YET("Muting") },
		{ group: "Actions", keys: "!", label: "Report as spam", context: "any", run: () => act({ action: "spam" }) },
		{ group: "Actions", keys: "#", label: "Delete", context: "any", run: () => act({ action: "trash" }) },
		{ group: "Actions", keys: "Delete", label: "Delete", context: "list", hidden: true, run: () => act({ action: "trash" }) },
		{ group: "Actions", keys: "r", label: "Reply", context: "thread", run: () => reply("reply") },
		{ group: "Actions", keys: "Shift+R", label: "Reply in a new window", context: "thread", run: () => reply("reply", true) },
		{ group: "Actions", keys: "a", label: "Reply all", context: "thread", run: () => reply("all") },
		{ group: "Actions", keys: "Shift+A", label: "Reply all in a new window", context: "thread", run: () => reply("all", true) },
		{ group: "Actions", keys: "f", label: "Forward", context: "thread", run: () => reply("forward") },
		{ group: "Actions", keys: "Shift+F", label: "Forward in a new window", context: "thread", run: () => reply("forward", true) },
		{ group: "Actions", keys: "Shift+N", label: "Update conversation", context: "any", run: refresh },
		{ group: "Actions", keys: "]", label: "Archive conversation and go older", context: "thread", run: () => act({ action: "archive", return: page()?.dataset.older || page()?.dataset.list }) },
		{ group: "Actions", keys: "[", label: "Archive conversation and go newer", context: "thread", run: () => act({ action: "archive", return: page()?.dataset.newer || page()?.dataset.list }) },
		{ group: "Actions", keys: "z", label: "Undo last action", context: "any", run: undo },
		{ group: "Actions", keys: "Shift+I", label: "Mark as read", context: "any", run: () => act({ action: "read" }) },
		{ group: "Actions", keys: "Shift+U", label: "Mark as unread", context: "any", run: () => act({ action: "unread" }) },
		{ group: "Actions", keys: "_", label: "Mark unread from the selected message", context: "thread", run: markUnreadFromCursor },
		{ group: "Actions", keys: "+", label: "Mark as important", context: "any", run: NOT_YET("Importance markers") },
		{ group: "Actions", keys: "-", label: "Mark as not important", context: "any", run: NOT_YET("Importance markers") },
		{ group: "Actions", keys: "b", label: "Snooze", context: "any", run: () => openMenu("snooze") },
		{ group: "Actions", keys: ";", label: "Expand entire conversation", context: "thread", run: () => messages().forEach((section) => expandMessage(section, true)) },
		{ group: "Actions", keys: ":", label: "Collapse entire conversation", context: "thread", run: () => messages().forEach((section) => expandMessage(section, section.classList.contains("is-last"))) },
		{ group: "Actions", keys: "Shift+T", label: "Add conversation to Tasks", context: "any", run: NOT_YET("Tasks") },
		{ group: "Jumping", keys: "g i", label: "Go to Inbox", context: "any", run: () => navigate("/v2/inbox") },
		{ group: "Jumping", keys: "g s", label: "Go to Starred conversations", context: "any", run: () => navigate("/v2/starred") },
		{ group: "Jumping", keys: "g b", label: "Go to Snoozed conversations", context: "any", run: () => navigate("/v2/snoozed") },
		{ group: "Jumping", keys: "g t", label: "Go to Sent messages", context: "any", run: () => navigate("/v2/sent") },
		{ group: "Jumping", keys: "g d", label: "Go to Drafts", context: "any", run: () => navigate("/v2/drafts") },
		{ group: "Jumping", keys: "g a", label: "Go to All mail", context: "any", run: () => navigate("/v2/all") },
		{ group: "Jumping", keys: "g l", label: "Go to label", context: "any", run: goToFolder },
		{ group: "Jumping", keys: "g k", label: "Go to Tasks", context: "any", run: NOT_YET("Tasks") },
		{ group: "Threadlist selection", keys: "* a", label: "Select all conversations", context: "list", run: () => selectWhere(() => true) },
		{ group: "Threadlist selection", keys: "* n", label: "Deselect all conversations", context: "list", run: () => selectWhere(() => false) },
		{ group: "Threadlist selection", keys: "* r", label: "Select read conversations", context: "list", run: () => selectWhere((row) => !row.classList.contains("is-unread")) },
		{ group: "Threadlist selection", keys: "* u", label: "Select unread conversations", context: "list", run: () => selectWhere((row) => row.classList.contains("is-unread")) },
		{ group: "Threadlist selection", keys: "* s", label: "Select starred conversations", context: "list", run: () => selectWhere((row) => !!row.querySelector(".row-star.is-starred")) },
		{ group: "Threadlist selection", keys: "* t", label: "Select unstarred conversations", context: "list", run: () => selectWhere((row) => !row.querySelector(".row-star.is-starred")) },
		{ group: "Navigation", keys: "g n", label: "Go to next page", context: "list", run: () => goPage("next") },
		{ group: "Navigation", keys: "g p", label: "Go to previous page", context: "list", run: () => goPage("prev") },
		{ group: "Navigation", keys: "u", label: "Back to threadlist", context: "thread", run: () => navigate(page()?.dataset.list) },
		{ group: "Navigation", keys: "k", label: "Newer conversation", context: "list", run: () => setCursor(cursor < 0 ? 0 : cursor - 1) },
		{ group: "Navigation", keys: "j", label: "Older conversation", context: "list", run: () => setCursor(cursor < 0 ? 0 : cursor + 1) },
		{ group: "Navigation", keys: "k", label: "Newer conversation", context: "thread", hidden: true, run: () => navigate(page()?.dataset.newer) },
		{ group: "Navigation", keys: "j", label: "Older conversation", context: "thread", hidden: true, run: () => navigate(page()?.dataset.older) },
		{ group: "Navigation", keys: "o", label: "Open conversation", context: "list", run: openCursor },
		{ group: "Navigation", keys: "Enter", label: "Open conversation", context: "list", run: openCursor },
		{ group: "Navigation", keys: "o", label: "Expand message", context: "thread", hidden: true, run: () => { const section = messages()[messageCursor]; expandMessage(section, section?.classList.contains("is-collapsed")); } },
		{ group: "Navigation", keys: "Enter", label: "Expand message", context: "thread", hidden: true, run: () => { const section = messages()[messageCursor]; expandMessage(section, section?.classList.contains("is-collapsed")); } },
		{ group: "Navigation", keys: "`", label: "Go to next Inbox section", context: "any", run: NOT_YET("Inbox sections") },
		{ group: "Navigation", keys: "~", label: "Go to previous Inbox section", context: "any", run: NOT_YET("Inbox sections") },
		{ group: "Application", keys: "c", label: "Compose", context: "any", run: () => openCompose() },
		{ group: "Application", keys: "d", label: "Compose in a new tab", context: "any", run: () => openCompose("/v2/compose") },
		{ group: "Application", keys: "/", label: "Search mail", context: "any", run: () => { const input = $(".search input"); input?.focus(); input?.select(); } },
		{ group: "Application", keys: "q", label: "Search chat contacts", context: "any", run: NOT_YET("Chat") },
		{ group: "Application", keys: ".", label: "Open \"more actions\" menu", context: "any", run: () => openMenu("message") || openMenu("move") },
		{ group: "Application", keys: "v", label: "Open \"move to\" menu", context: "any", run: () => openMenu("move") },
		{ group: "Application", keys: "l", label: "Open \"label as\" menu", context: "any", run: () => openMenu("move") },
		{ group: "Application", keys: "?", label: "Open keyboard shortcut help", context: "any", run: () => openHelp() },
	];

	function openCursor() {
		const row = cursorRow();
		if (row) navigate(row.dataset.href);
	}

	function markUnreadFromCursor() {
		const section = messages()[messageCursor];
		if (!section) return;
		load("POST", "/v2/unread-from", { messageId: section.dataset.id, return: page()?.dataset.list ?? "/v2/inbox" });
	}

	function goToFolder() {
		const first = $("#nav a[href^='/v2/folder/']");
		if (first) {
			body.classList.add("nav-open");
			first.focus();
		} else {
			toast("You have no folders yet.");
		}
	}

	function escape() {
		if (closeHelp()) return;
		if ($("details.menu[open]")) return closeMenus();
		if (body.classList.contains("nav-open")) return closeNav();
		const composer = $("#compose-dock [data-composer]");
		if (composer) {
			composer.classList.remove("is-minimized");
			$("[data-editor]", composer)?.focus();
			return;
		}
		if (pageKind() === "list" && selectedIds().length) selectWhere(() => false);
	}

	function keyName(event) {
		if (event.key === "Escape") return event.shiftKey ? "Shift+Escape" : "Escape";
		if (event.key.length === 1 && /[a-z]/i.test(event.key) && event.shiftKey) return `Shift+${event.key.toUpperCase()}`;
		if (event.key === "Backspace") return "Delete";
		return event.key;
	}

	let sequence = "";
	let sequenceTimer = 0;

	document.addEventListener("keydown", (event) => {
		const composer = activeComposer();
		if (composer && composerKey(event, composer)) return;
		if (event.defaultPrevented) return;
		if (event.key === "Escape" && isTyping(event.target)) {
			event.target.blur();
			return;
		}
		if (!shortcutsOn() || isTyping(event.target)) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		const kind = pageKind();
		const name = keyName(event);
		// Enter on a focused link or button already activates it.
		if (name === "Enter" && event.target instanceof Element && event.target.closest("a, button, summary")) return;
		const candidate = sequence ? `${sequence} ${name}` : name;
		const matches = (keys) => KEYMAP.filter((entry) => entry.run && entry.keys === keys && (entry.context === "any" || entry.context === kind));
		const exact = matches(candidate);
		if (exact.length) {
			event.preventDefault();
			sequence = "";
			clearTimeout(sequenceTimer);
			exact[0].run();
			return;
		}
		if (!sequence && (name === "g" || name === "*")) {
			event.preventDefault();
			sequence = name;
			clearTimeout(sequenceTimer);
			sequenceTimer = setTimeout(() => (sequence = ""), 1200);
			return;
		}
		sequence = "";
	});

	/* ---------- help overlay ---------- */

	function closeHelp() {
		const overlay = $(".help-overlay");
		if (!overlay) return false;
		overlay.remove();
		return true;
	}

	function openHelp() {
		if (closeHelp()) return;
		const overlay = document.createElement("div");
		overlay.className = "help-overlay";
		overlay.addEventListener("click", (event) => {
			if (event.target === overlay || (event.target instanceof Element && event.target.closest("[data-help-close]"))) overlay.remove();
		});
		const panel = document.createElement("div");
		panel.className = "help-panel";
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "Keyboard shortcuts");
		const header = document.createElement("header");
		const title = document.createElement("h2");
		title.textContent = "Keyboard shortcuts";
		const close = document.createElement("button");
		close.type = "button";
		close.className = "icon-button";
		close.dataset.helpClose = "1";
		close.setAttribute("aria-label", "Close");
		close.textContent = "✕";
		header.append(title, close);
		const columns = document.createElement("div");
		columns.className = "help-columns";
		const groups = new Map();
		for (const entry of KEYMAP) {
			if (entry.hidden) continue;
			if (!groups.has(entry.group)) groups.set(entry.group, []);
			const list = groups.get(entry.group);
			if (!list.some((item) => item.label === entry.label)) list.push(entry);
		}
		for (const [group, entries] of groups) {
			const section = document.createElement("section");
			section.className = "help-group";
			const heading = document.createElement("h3");
			heading.textContent = group;
			section.append(heading);
			for (const entry of entries) {
				const row = document.createElement("div");
				row.className = "help-row";
				const label = document.createElement("span");
				label.textContent = entry.label;
				const keys = document.createElement("span");
				// Sequences ("g i") get a key cap per key; combinations are one cap.
				for (const part of entry.context === "help" ? [entry.keys] : entry.keys.split(" ")) {
					const kbd = document.createElement("kbd");
					kbd.textContent = part.replace("Shift+", "Shift + ");
					keys.append(kbd);
				}
				row.append(label, keys);
				section.append(row);
			}
			columns.append(section);
		}
		const note = document.createElement("p");
		note.className = "help-note";
		note.textContent = shortcutsOn()
			? "Shortcuts follow Gmail. Turn them off in Settings › Account."
			: "Keyboard shortcuts are turned off in Settings › Account.";
		panel.append(header, columns, note);
		overlay.append(panel);
		body.append(overlay);
		close.focus();
	}

	/* ---------- live updates ---------- */

	function refreshQuietly() {
		// Replayed actions must reach the server before the list is reloaded.
		if (deferRefreshUntilDrained()) return;
		const kind = pageKind();
		const busy = selectedIds().length || $("details.menu[open]") || isTyping(document.activeElement);
		const path = `${location.pathname}${location.search}`;
		if (kind === "list" && !busy) {
			load("GET", path);
		} else {
			window.htmx.ajax("GET", `/v2/poll?path=${encodeURIComponent(path)}`, { target: "#nav", select: "#nav", swap: "outerHTML", source: body });
		}
	}

	function connect(attempt = 0) {
		if (!("WebSocket" in window)) return;
		const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/realtime`);
		let heartbeat = 0;
		socket.addEventListener("open", () => {
			attempt = 0;
			heartbeat = setInterval(() => socket.readyState === 1 && socket.send("ping"), 25000);
		});
		socket.addEventListener("message", (event) => {
			try {
				const payload = JSON.parse(event.data);
				if (payload?.type === "new_message") refreshQuietly();
			} catch {
				/* heartbeat replies */
			}
		});
		socket.addEventListener("close", () => {
			clearInterval(heartbeat);
			setTimeout(() => connect(attempt + 1), Math.min(1000 * 2 ** attempt, 30000));
		});
	}
	connect();
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && pageKind() === "list") refreshQuietly();
	});

	/* ---------- installable app ---------- */

	// The server renders the worker URL with the asset versions it precaches.
	function registerServiceWorker() {
		const url = body.dataset.sw;
		if (!url || !("serviceWorker" in navigator) || !window.isSecureContext) return;
		navigator.serviceWorker.register(url, { scope: "/v2/" }).catch(() => {
			/* Offline support is optional; the app works without it. */
		});
	}
	if (document.readyState === "complete") registerServiceWorker();
	else window.addEventListener("load", registerServiceWorker, { once: true });

	/* ---------- push notifications ---------- */

	// The sidebar's [data-push] button. States: on, off, blocked, install (iOS
	// outside the installed app, where Safari has no push), unsupported (hidden).
	const PUSH_LABELS = {
		on: "Notifications on",
		off: "Turn on notifications",
		blocked: "Notifications blocked",
		install: "Install the app first",
		busy: "Notifications…",
	};
	const PUSH_TITLES = {
		on: "New mail shows a notification on this device. Click to turn off.",
		off: "Show a notification on this device when new mail arrives.",
		blocked: "Notifications are blocked for this site. Allow them in the browser's site settings.",
		install: "On iPhone and iPad, notifications work only from the installed app: Share, then Add to Home Screen.",
		busy: "",
	};
	let pushState = "unsupported";

	const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
	const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
	const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;

	function base64UrlToBytes(value) {
		const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
		const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	}

	function bytesToBase64Url(buffer) {
		return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}

	function applyPushState() {
		for (const button of $$("[data-push]")) {
			button.hidden = pushState === "unsupported";
			button.dataset.state = pushState;
			button.disabled = pushState === "busy";
			button.title = PUSH_TITLES[pushState] ?? "";
			button.setAttribute("aria-pressed", pushState === "on" ? "true" : "false");
			const label = $("[data-push-label]", button);
			if (label) label.textContent = PUSH_LABELS[pushState] ?? "";
		}
	}

	function setPushState(state) {
		pushState = state;
		applyPushState();
	}

	/** The /v2/ registration once it has an active worker (pushManager needs one). */
	async function activeRegistration() {
		let registration = await navigator.serviceWorker.getRegistration("/v2/");
		if (!registration && body.dataset.sw) registration = await navigator.serviceWorker.register(body.dataset.sw, { scope: "/v2/" });
		if (!registration) throw new Error("No service worker");
		if (registration.active) return registration;
		const worker = registration.installing || registration.waiting;
		await new Promise((resolve) => {
			worker?.addEventListener("statechange", () => worker.state === "activated" && resolve());
		});
		return registration;
	}

	async function postJson(path, value) {
		const response = await fetch(path, {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(value),
		});
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.error || "Could not update notifications.");
		}
	}

	async function currentSubscription() {
		const registration = await navigator.serviceWorker.getRegistration("/v2/");
		return registration ? registration.pushManager.getSubscription() : null;
	}

	/** Whether the server still pushes to this endpoint for whoever is signed in; null when it cannot say. */
	async function serverHasSubscription(subscription) {
		try {
			const response = await fetch("/v2/push/check", {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ endpoint: subscription.endpoint }),
			});
			if (!response.ok) return null;
			return (await response.json()).subscribed === true;
		} catch {
			return null;
		}
	}

	async function readPushState() {
		const key = body.dataset.vapidKey;
		if (!key) return "unsupported";
		if (isIos() && !isStandalone()) return "install";
		if (!pushSupported()) return "unsupported";
		if (Notification.permission === "denied") return "blocked";
		const subscription = await currentSubscription().catch(() => null);
		if (!subscription || Notification.permission !== "granted") return "off";
		// A subscription made under an older server key can no longer be pushed to.
		const subscribedKey = subscription.options?.applicationServerKey;
		if (subscribedKey && bytesToBase64Url(subscribedKey) !== key) return "off";
		// Signing out drops the server's row but not the browser's subscription:
		// the next person to sign in here starts with notifications off.
		if (await serverHasSubscription(subscription) === false) {
			await subscription.unsubscribe().catch(() => {});
			return "off";
		}
		return "on";
	}

	async function subscribePush() {
		const key = body.dataset.vapidKey;
		setPushState("busy");
		try {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				setPushState(permission === "denied" ? "blocked" : "off");
				return;
			}
			const registration = await activeRegistration();
			const existing = await registration.pushManager.getSubscription();
			const existingKey = existing?.options?.applicationServerKey;
			if (existing && existingKey && bytesToBase64Url(existingKey) !== key) await existing.unsubscribe();
			const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) });
			try {
				await postJson("/v2/push/subscribe", { ...subscription.toJSON(), applicationServerKey: key });
			} catch (error) {
				await subscription.unsubscribe().catch(() => {});
				throw error;
			}
			setPushState("on");
			toast("Notifications are on for this device.");
		} catch (error) {
			setPushState(await readPushState());
			toast(error instanceof Error && error.message ? error.message : "Could not turn on notifications.");
		}
	}

	async function unsubscribePush() {
		setPushState("busy");
		try {
			const subscription = await currentSubscription();
			if (subscription) {
				await postJson("/v2/push/unsubscribe", { endpoint: subscription.endpoint });
				await subscription.unsubscribe();
			}
			setPushState("off");
			toast("Notifications are off for this device.");
		} catch (error) {
			setPushState(await readPushState());
			toast(error instanceof Error && error.message ? error.message : "Could not turn off notifications.");
		}
	}

	document.addEventListener("click", (event) => {
		const button = event.target instanceof Element ? event.target.closest("[data-push]") : null;
		if (!button) return;
		if (pushState === "off") subscribePush();
		else if (pushState === "on") unsubscribePush();
		else if (pushState === "install" || pushState === "blocked") toast(PUSH_TITLES[pushState]);
	});
	// #nav is re-rendered on every navigation; keep the control's state on it.
	document.addEventListener("htmx:afterSettle", applyPushState);
	document.addEventListener("htmx:oobAfterSwap", applyPushState);

	readPushState().then(setPushState);

	// A notification click in the service worker opens its message here.
	navigator.serviceWorker?.addEventListener("message", (event) => {
		const url = event.data?.type === "mf:open" ? event.data.url : null;
		if (typeof url !== "string") return;
		const target = new URL(url, location.href);
		if (target.origin === location.origin && target.pathname.startsWith("/v2/")) navigate(`${target.pathname}${target.search}`);
	});

	/* ---------- offline: banner, cached pages and the outbox ----------
	   offline.js holds the rules and the IndexedDB outbox. This part wires them
	   to the page: the topbar banner, full navigations to cached pages while
	   offline, handing boosted pages to the service worker to keep, queuing
	   actions, drafts and sends that could not reach the server, and replaying
	   them in order once it can. Everything is keyed by <body data-user>. */

	const Offline = window.MailflareOffline;
	const currentUser = body.dataset.user ?? "";
	let draining = null;
	let refreshAfterDrain = false;
	let pendingCount = 0;

	function withOutboxLock(fn) {
		return Offline ? Offline.withLock(fn) : fn();
	}

	function postToWorker(message) {
		navigator.serviceWorker?.controller?.postMessage(message);
	}

	function requestOutboxSync() {
		navigator.serviceWorker?.ready.then((registration) => registration.sync?.register(Offline.SYNC_TAG)).catch(() => {
			/* No Background Sync: the page replays on "online" and on load. */
		});
	}

	function formatCachedAt(ms) {
		const date = new Date(ms);
		const sameDay = date.toDateString() === new Date().toDateString();
		return new Intl.DateTimeFormat(undefined, sameDay ? { hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(date);
	}

	function updateConnectivity() {
		const offline = !navigator.onLine;
		const cachedAt = Number(body.dataset.cachedAt) || 0;
		body.classList.toggle("is-offline", offline);
		const banner = $("[data-offline-banner]");
		const text = $("[data-offline-text]");
		if (banner && text) {
			const waiting = pendingCount ? ` · ${pendingCount} ${pendingCount === 1 ? "change" : "changes"} waiting` : "";
			const copy = cachedAt ? ` · copy from ${formatCachedAt(cachedAt)}` : "";
			banner.hidden = !offline && !cachedAt && !pendingCount;
			text.textContent = offline ? `Offline${copy}${waiting}` : cachedAt ? `Couldn't reach Mailflare${copy}${waiting}` : `Syncing${waiting}`;
		}
		// Search runs on the server.
		const search = $(".search input");
		if (search) {
			search.disabled = offline;
			search.placeholder = offline ? "Search needs a connection" : "Search mail";
		}
	}

	async function updatePending() {
		if (!Offline || !currentUser) return;
		try {
			pendingCount = (await Offline.outbox.all()).filter((entry) => entry.user === currentUser).length;
		} catch {
			pendingCount = 0;
		}
		updateConnectivity();
	}

	async function signedOut() {
		if (Offline) await Offline.purgeEverything().catch(() => {});
		location.href = new URL("/login", location.href).href;
	}

	/** Store what a failed request would have done; true when it was queued. */
	async function queueOffline(kind, fields, key) {
		if (!Offline || !currentUser) return false;
		const entry = {
			id: Offline.newRequestId(),
			user: currentUser,
			kind,
			key: key || undefined,
			createdAt: Date.now(),
			fields: Offline.prepareFields(kind, fields),
		};
		try {
			await withOutboxLock(() => Offline.outbox.add(entry));
		} catch {
			return false;
		}
		requestOutboxSync();
		await updatePending();
		return true;
	}

	/** A toast for the next page, when going offline means a full navigation. */
	function flashAfterNavigation(message) {
		try {
			sessionStorage.setItem("mf_flash", message);
		} catch {
			/* sessionStorage unavailable */
		}
	}
	function showFlash() {
		try {
			const message = sessionStorage.getItem("mf_flash");
			sessionStorage.removeItem("mf_flash");
			if (message) toast(message);
		} catch {
			/* sessionStorage unavailable */
		}
	}

	function fieldsOf(formData) {
		return formData ? [...formData] : [];
	}

	/**
	 * htmx could not reach the server. A forward action, draft or send goes to
	 * the outbox (the rows already changed); a boosted page becomes a full
	 * navigation the service worker can answer from its cache.
	 */
	function handleOfflineFailure(detail) {
		const config = detail.requestConfig;
		if (!config) return false;
		const url = new URL(config.path, location.href);
		if (config.verb === "get" && config.boosted && url.origin === location.origin) {
			location.href = url.href;
			return true;
		}
		if (!Offline || config.verb !== "post") return false;
		const fields = fieldsOf(config.formData);
		const kind = Offline.queueKind(url.pathname, fields);
		if (!kind || kind === "draft") return false;
		const value = (name) => Offline.fieldValue(fields, name);
		if (kind === "send") {
			const form = config.elt?.closest?.("[data-composer]");
			if (form) {
				form.dataset.closed = "1";
				setState(form, "Queued");
			}
			queueOffline("send", fields, form?.dataset.clientKey).then((queued) => {
				if (!queued) {
					if (form) {
						delete form.dataset.closed;
						setState(form, "Not sent");
					}
					return toast("You appear to be offline.");
				}
				const note = "You're offline. The message will be sent when you're back online.";
				if (!form || form.dataset.mode !== "page") {
					form?.remove();
					toast(note);
				} else {
					flashAfterNavigation(note);
					location.href = value("return") || "/v2/inbox";
				}
			});
			return true;
		}
		queueOffline("act", fields).then((queued) => {
			if (!queued) return toast("You appear to be offline.");
			if (value("conversation") === "1") {
				const action = value("action");
				if (action === "star" || action === "unstar") {
					const star = $("#main .star-button");
					star?.classList.toggle("is-starred", action === "star");
					if (star) star.value = action === "star" ? "unstar" : "star";
				} else {
					// The conversation leaves the view, as it would online.
					flashAfterNavigation("You're offline. This will sync when you're back online.");
					location.href = value("return") || "/v2/inbox";
					return;
				}
			}
			toast("You're offline. This will sync when you're back online.");
		});
		return true;
	}

	/* Drafts: the device copy is an outbox entry, one per composer. */

	async function keepDraftOnDevice(form, data) {
		if (!Offline || !currentUser) return null;
		const entry = {
			id: Offline.newRequestId(),
			user: currentUser,
			kind: "draft",
			key: form.dataset.clientKey,
			createdAt: Date.now(),
			fields: Offline.prepareFields("draft", fieldsOf(data)),
		};
		try {
			await Offline.outbox.add(entry);
			return entry.id;
		} catch {
			return null;
		}
	}

	async function forgetOnDevice(id) {
		if (!id) return;
		await Offline.outbox.delete(id).catch(() => {});
		await updatePending();
	}

	/** A composer reopened on this device gets back what was typed but never reached the server. */
	async function restoreDraftFromDevice(form) {
		form.dataset.clientKey = form.elements.draftId?.value || Offline?.newRequestId() || String(Date.now());
		if (!Offline || !currentUser || !form.elements.draftId?.value) return;
		let entry;
		try {
			entry = (await Offline.outbox.all()).filter((item) => item.user === currentUser && item.kind === "draft" && item.key === form.dataset.clientKey).at(-1);
		} catch {
			return;
		}
		if (!entry) return;
		for (const name of ["to", "cc", "bcc", "subject"]) {
			const input = form.elements[name];
			const saved = Offline.fieldValue(entry.fields, name);
			if (input && saved !== input.value) {
				input.value = saved;
				input.closest("[data-cmp-row]")?.removeAttribute("hidden");
			}
		}
		const editor = $("[data-editor]", form);
		const html = Offline.fieldValue(entry.fields, "html");
		if (editor && html) editor.innerHTML = html;
		setState(form, "Saved on this device");
	}

	function applyDraftId(key, draftId) {
		const form = $$("[data-composer]").find((item) => item.dataset.clientKey === key);
		if (form && !form.elements.draftId.value) form.elements.draftId.value = draftId;
	}

	/* Replay */

	function deferRefreshUntilDrained() {
		if (!draining) return false;
		refreshAfterDrain = true;
		return true;
	}

	/** Replay the outbox, then reload what is on screen so it shows the result. */
	function drainOutbox() {
		if (!Offline || !currentUser || !navigator.onLine) return Promise.resolve(null);
		if (draining) return draining;
		const refused = [];
		draining = (async () => {
			try {
				return await Offline.withLock(() => Offline.drain(Offline.outbox, {
					fetch: (path, init) => fetch(path, init),
					user: currentUser,
					onDropped: (message) => refused.push(message),
					onDraftId: applyDraftId,
				}));
			} catch {
				return null;
			}
		})();
		return draining.then(async (result) => {
			draining = null;
			await updatePending();
			if (result?.signedOut) {
				await signedOut();
				return result;
			}
			if (refused.length) {
				// As for an action refused online: show the truth, then say why.
				await refresh();
				toast(refused[refused.length - 1]);
			} else if (result?.sent || refreshAfterDrain) {
				refreshQuietly();
			}
			refreshAfterDrain = false;
			return result;
		});
	}

	/** Rows still waiting on queued actions look the way those actions will leave them. */
	async function applyPendingToList() {
		if (!Offline || !currentUser || pageKind() !== "list") return;
		let entries;
		try {
			entries = (await Offline.outbox.all()).filter((entry) => entry.user === currentUser && entry.kind === "act");
		} catch {
			return;
		}
		const view = page()?.dataset.view ?? "";
		for (const entry of entries) {
			const values = { action: Offline.fieldValue(entry.fields, "action"), move: Offline.fieldValue(entry.fields, "move"), snooze: Offline.fieldValue(entry.fields, "snooze") };
			const ids = entry.fields.filter(([name]) => name === "ids").map(([, id]) => id);
			for (const row of rows().filter((item) => ids.includes(item.dataset.id))) {
				if (leavesList(values, view)) row.remove();
				else if (values.action === "read" || values.action === "unread") row.classList.toggle("is-unread", values.action === "unread");
				else if (values.action === "star" || values.action === "unstar") {
					const star = row.querySelector("[data-star]");
					star?.classList.toggle("is-starred", values.action === "star");
					star?.setAttribute("aria-pressed", String(values.action === "star"));
				}
			}
		}
	}

	/* Wiring */

	// Offline, boosted links become full navigations the worker answers from its cache.
	document.addEventListener("htmx:beforeRequest", (event) => {
		const config = event.detail.requestConfig;
		if (navigator.onLine || config?.verb !== "get" || !config.boosted) return;
		event.preventDefault();
		location.href = new URL(config.path, location.href).href;
	});

	// Boosted pages never pass through the worker's cache; hand it the documents.
	document.addEventListener("htmx:afterRequest", (event) => {
		const { xhr, requestConfig: config, successful } = event.detail;
		if (!xhr || !config || config.verb !== "get") return;
		let url;
		try {
			url = new URL(xhr.responseURL, location.href);
		} catch {
			return;
		}
		if (url.origin !== location.origin) return;
		if (url.pathname === "/login") {
			signedOut();
			return;
		}
		if (!successful || xhr.status !== 200 || url.pathname !== new URL(config.path, location.href).pathname) return;
		if (Offline?.cacheKind(url) === "page") postToWorker({ type: "store-page", url: url.href, html: xhr.responseText });
		if (event.detail.target?.id === "main" && body.dataset.cachedAt) {
			delete body.dataset.cachedAt;
			updateConnectivity();
		}
	});

	document.addEventListener("htmx:afterSettle", (event) => {
		if (event.detail.target?.id === "main") applyPendingToList();
	});

	// Online, the worker keeps a copy of an attachment as it is downloaded (the
	// download itself never passes through it); offline, that copy is saved instead.
	document.addEventListener("click", (event) => {
		const link = event.target instanceof Element ? event.target.closest("a.attachment") : null;
		if (!link) return;
		if (navigator.onLine) {
			postToWorker({ type: "keep-file", url: link.href });
			return;
		}
		event.preventDefault();
		fetch(link.href)
			.then((response) => (response.ok ? response.blob() : Promise.reject(new Error("not cached"))))
			.then((blob) => {
				const href = URL.createObjectURL(blob);
				const save = document.createElement("a");
				save.href = href;
				save.download = link.getAttribute("download") || "";
				save.click();
				setTimeout(() => URL.revokeObjectURL(href), 30000);
			})
			.catch(() => toast("This attachment isn't available offline."));
	});

	navigator.serviceWorker?.addEventListener("message", (event) => {
		const data = event.data;
		if (data?.type === "outbox-draft") applyDraftId(data.key, data.draftId);
		else if (data?.type === "outbox-dropped") refresh().then(() => toast(data.message));
		else if (data?.type === "outbox-drained") {
			updatePending();
			if (data.result?.signedOut) signedOut();
			else if (data.result?.sent) refreshQuietly();
		}
	});

	window.addEventListener("online", () => {
		updateConnectivity();
		drainOutbox().then((result) => {
			if (result && !result.sent && !refreshAfterDrain) refreshQuietly();
		});
	});
	window.addEventListener("offline", updateConnectivity);

	updateConnectivity();
	showFlash();
	if (Offline && currentUser) {
		// Another account's caches and queued actions go before anything else runs.
		Offline.adoptUser(currentUser).catch(() => {}).then(async () => {
			await updatePending();
			await applyPendingToList();
			if (!navigator.onLine) return;
			await drainOutbox();
			// Keep the full-page composer so mail can be written offline.
			try {
				if (!sessionStorage.getItem("mf_compose_warm")) {
					sessionStorage.setItem("mf_compose_warm", "1");
					navigator.serviceWorker?.ready.then((registration) => registration.active?.postMessage({ type: "warm", url: "/v2/compose" }));
				}
			} catch {
				/* sessionStorage unavailable */
			}
		});
	}
})();
