import { html, type Html } from "../html";
import { icon } from "../icons";
import type { V2Folder } from "../types";

/** A dropdown that works without script: <details> opens, buttons submit `formId`. */
function menu(name: string, label: string, iconName: string, key: string | null, body: Html, className = ""): Html {
	return html`<details class="${`menu ${className}`.trim()}" data-menu="${name}">
		<summary class="icon-button" title="${key ? `${label} (${key})` : label}" aria-label="${label}">${icon(iconName)}</summary>
		<div class="menu-panel" role="menu">${body}</div>
	</details>`;
}

export function moveMenu(formId: string, folders: V2Folder[]): Html {
	return menu("move", "Move to", "move", "v", html`
		<div class="menu-heading">Move to</div>
		<button class="menu-item" type="submit" form="${formId}" name="move" value="inbox" role="menuitem">${icon("inbox")}Inbox</button>
		<button class="menu-item" type="submit" form="${formId}" name="move" value="archive" role="menuitem">${icon("archive")}Archive</button>
		<button class="menu-item" type="submit" form="${formId}" name="move" value="spam" role="menuitem">${icon("alert")}Spam</button>
		<button class="menu-item" type="submit" form="${formId}" name="move" value="trash" role="menuitem">${icon("trash")}Trash</button>
		${folders.length ? html`<div class="menu-sep"></div>` : ""}
		${folders.map((folder) => html`<button class="menu-item" type="submit" form="${formId}" name="move" value="${`folder:${folder.id}`}" role="menuitem">${icon("folder")}${folder.name}</button>`)}
	`);
}

export type MoreMenuItem = { value: string; label: string; icon: string };

/**
 * The phone toolbar's overflow: the same `action` buttons the wider toolbar shows inline
 * (as `.tb-overflow`), as a sheet. Hidden from 900px up.
 */
export function moreMenu(formId: string, items: MoreMenuItem[]): Html {
	return menu("more", "More actions", "more", null, html`
		${items.map((item) => html`<button class="menu-item" type="submit" form="${formId}" name="action" value="${item.value}" role="menuitem">${icon(item.icon)}${item.label}</button>`)}
	`, "tb-more");
}

/**
 * Enter in the snooze menu's date field clicks the form's first submit button.
 * Render this ahead of the toolbar's other buttons so that is the custom
 * snooze, not Archive.
 */
export function snoozeDefaultButton(formId: string): Html {
	return html`<button type="submit" form="${formId}" name="snooze" value="custom" hidden tabindex="-1" aria-hidden="true"></button>`;
}

export function snoozeMenu(formId: string): Html {
	return menu("snooze", "Snooze", "clock", "b", html`
		<div class="menu-heading">Snooze until…</div>
		<button class="menu-item" type="submit" form="${formId}" name="snooze" value="later" role="menuitem">Later today<span class="menu-hint">6:00 PM</span></button>
		<button class="menu-item" type="submit" form="${formId}" name="snooze" value="tomorrow" role="menuitem">Tomorrow<span class="menu-hint">8:00 AM</span></button>
		<button class="menu-item" type="submit" form="${formId}" name="snooze" value="weekend" role="menuitem">This weekend<span class="menu-hint">Sat 8:00 AM</span></button>
		<button class="menu-item" type="submit" form="${formId}" name="snooze" value="nextweek" role="menuitem">Next week<span class="menu-hint">Mon 8:00 AM</span></button>
		<div class="menu-sep"></div>
		<div class="menu-custom">
			<input type="datetime-local" name="snoozeAt" form="${formId}" aria-label="Pick date and time">
			<button class="button" type="submit" form="${formId}" name="snooze" value="custom">Snooze</button>
		</div>
	`);
}
