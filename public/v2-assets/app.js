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
	document.addEventListener("htmx:sendError", () => toast("You appear to be offline."));

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
		});
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
		try {
			const response = await fetch("/v2/draft", { method: "POST", body: composerData(form, false), headers: { Accept: "application/json" } });
			const result = await response.json();
			if (response.ok && result.draftId) {
				form.elements.draftId.value = result.draftId;
				setState(form, "Draft saved");
			} else {
				setState(form, result.error ?? "Not saved");
			}
		} catch {
			setState(form, "Offline – not saved");
		}
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
		return load("GET", `${location.pathname}${location.search}`);
	}

	function undo() {
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
})();
