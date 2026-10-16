export type ChangeKind = "created" | "updated" | "destroyed";

export type ChangeLogRow = {
	seq: number;
	type: "email" | "mailbox";
	objectId: string;
	mailboxId: string | null;
	threadKey: string | null;
	kind: ChangeKind;
};

export type ChangeWindow<T> = { rows: T[]; newSeq: number; hasMore: boolean };

export type ClassifiedChanges = { created: string[]; updated: string[]; destroyed: string[] };

/** Where a client's `sinceState` sits relative to the retained log. */
export type ChangeHistory =
	| { status: "unknown" }
	| { status: "current"; seq: number }
	| { status: "available"; since: number; current: number };
