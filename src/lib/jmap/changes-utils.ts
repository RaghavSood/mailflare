import { invalidArguments } from "./errors";
import type { ChangeKind, ChangeLogRow, ChangeWindow, ClassifiedChanges } from "./changes-types";

/** Email and Mailbox states are the change-log sequence as a decimal string. */
export function formatSeqState(seq: number): string {
	return String(seq);
}

/**
 * A state a client hands back. Only the plain sequence form is accepted;
 * anything else (including the dotted digest strings older builds issued)
 * is unknown history, and the caller answers cannotCalculateChanges.
 */
export function parseSeqState(value: unknown): number | null {
	if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return null;
	return Number(value);
}

/** RFC 8620 §5.2: `maxChanges` is optional and, when given, a positive integer. */
export function parseMaxChanges(value: unknown): number | null {
	if (value === undefined || value === null) return null;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw invalidArguments("maxChanges must be a positive integer");
	return parsed;
}

/**
 * Mailbox state carries a digest of the accessible mailbox ids after the
 * sequence. A new mailbox or a sharing grant is not in the change log, so a
 * client whose digest differs must refetch every Mailbox.
 */
export function formatMailboxState(seq: number, mailboxIds: Iterable<string>): string {
	return `${seq}-${digestIds(mailboxIds)}`;
}

export function parseMailboxState(value: unknown): { seq: number; digest: string } | null {
	if (typeof value !== "string") return null;
	const match = value.match(/^(\d{1,15})-([0-9a-f]{8})$/);
	return match ? { seq: Number(match[1]), digest: match[2] } : null;
}

/** FNV-1a over the sorted ids: stable, short, and cheap enough to compute per request. */
export function digestIds(ids: Iterable<string>): string {
	const sorted = Array.from(ids).sort();
	let hash = 0x811c9dc5;
	for (const id of sorted) {
		for (let index = 0; index < id.length; index += 1) {
			hash ^= id.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		hash ^= 0x1f;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Take rows in sequence order until the next row would introduce a
 * `maxChanges + 1`th distinct key. Cutting on a sequence boundary keeps the
 * RFC 8620 §5.2 promise that every change at or before `newState` has been
 * reported: a key left out has no rows at or below the cut.
 */
export function takeChangeWindow<T extends ChangeLogRow>(rows: T[], keyOf: (row: T) => string, maxChanges: number | null, currentSeq: number): ChangeWindow<T> {
	if (maxChanges === null) return { rows, newSeq: currentSeq, hasMore: false };
	const keys = new Set<string>();
	const taken: T[] = [];
	for (const row of rows) {
		const key = keyOf(row);
		if (!keys.has(key) && keys.size >= maxChanges) {
			return { rows: taken, newSeq: taken.length ? taken[taken.length - 1].seq : 0, hasMore: true };
		}
		keys.add(key);
		taken.push(row);
	}
	return { rows: taken, newSeq: currentSeq, hasMore: false };
}

/**
 * Fold a window of log rows into the three RFC 8620 §5.2 lists. An object
 * created and destroyed inside the window is omitted; one created and then
 * updated is created; anything else that still exists is updated.
 */
export function classifyChanges(rows: ChangeLogRow[]): ClassifiedChanges {
	const state = new Map<string, { createdSince: boolean; last: ChangeKind }>();
	for (const row of rows) {
		const current = state.get(row.objectId) ?? { createdSince: false, last: row.kind };
		if (row.kind === "created") current.createdSince = true;
		current.last = row.kind;
		state.set(row.objectId, current);
	}
	const created: string[] = [];
	const updated: string[] = [];
	const destroyed: string[] = [];
	for (const [id, { createdSince, last }] of state) {
		if (last === "destroyed") {
			if (!createdSince) destroyed.push(id);
		} else if (createdSince) {
			created.push(id);
		} else {
			updated.push(id);
		}
	}
	return { created, updated, destroyed };
}

/**
 * Threads change with their messages. A thread with no members left is
 * destroyed; one whose every current member was created in the window is
 * created; any other touched thread is updated.
 */
export function classifyThreadChanges(rows: ChangeLogRow[], membersByThread: Map<string, string[]>): ClassifiedChanges {
	const { created: createdEmails } = classifyChanges(rows);
	const createdSet = new Set(createdEmails);
	const created: string[] = [];
	const updated: string[] = [];
	const destroyed: string[] = [];
	for (const key of new Set(rows.map((row) => row.threadKey ?? row.objectId))) {
		const members = membersByThread.get(key) ?? [];
		if (members.length === 0) destroyed.push(key);
		else if (members.every((id) => createdSet.has(id))) created.push(key);
		else updated.push(key);
	}
	return { created, updated, destroyed };
}

/**
 * RFC 8620 §5.6 `added`/`removed` from the ids that changed and the query's
 * current ordered result. Every changed id is removed (a no-op for ids the
 * client never held) and re-added at its current index when it still matches,
 * which also covers sort-position moves.
 */
export function diffQueryResults(changedIds: Iterable<string>, ordered: string[], upToId: string | null): { removed: string[]; added: Array<{ id: string; index: number }> } {
	const changed = new Set(changedIds);
	const limit = upToId ? ordered.indexOf(upToId) : -1;
	const bound = limit >= 0 ? limit : ordered.length - 1;
	const added: Array<{ id: string; index: number }> = [];
	for (let index = 0; index <= bound; index += 1) {
		if (changed.has(ordered[index])) added.push({ id: ordered[index], index });
	}
	return { removed: Array.from(changed), added };
}
