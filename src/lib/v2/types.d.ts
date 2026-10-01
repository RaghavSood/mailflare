import type { SessionUser } from "@/lib/auth/types";

export type V2ViewKey =
	| "inbox"
	| "starred"
	| "snoozed"
	| "sent"
	| "drafts"
	| "archive"
	| "all"
	| "spam"
	| "trash"
	| "folder"
	| "search";

export type V2IconName =
	| "inbox"
	| "star"
	| "clock"
	| "send"
	| "file"
	| "archive"
	| "mail"
	| "alert"
	| "trash"
	| "folder";

export type V2View = {
	key: Exclude<V2ViewKey, "folder" | "search">;
	label: string;
	icon: V2IconName;
	/** Gmail-style "go to" sequence, shown in the help overlay. */
	go: string | null;
	classic: string;
};

export type V2Route =
	| { kind: "home" }
	| { kind: "notFound" }
	| { kind: "view"; view: V2ViewKey; folderId: string | null; messageId: string | null }
	| { kind: "action"; name: string };

export type V2Theme = "system" | "light" | "dark";

export type V2Mailbox = {
	id: string;
	address: string;
	name: string;
	userId: string;
	signature: string | null;
	canSend: boolean;
	canManage: boolean;
	senderAddresses: string[];
	catchAllHostnames: string[];
	domainId: string;
	localPart: string;
	useAllDomains: boolean;
};

/** Everything a page render needs about who is looking and with what settings. */
export type V2Context = {
	env: CloudflareEnv;
	request: Request;
	user: SessionUser;
	url: URL;
	mailboxes: V2Mailbox[];
	/** Mailboxes the current view reads from: the selected one, or all of them. */
	scopeMailboxIds: string[];
	selectedMailboxId: string | null;
	theme: V2Theme;
	shortcutsEnabled: boolean;
	/** Set by htmx; such requests may skip parts of the page the client keeps. */
	htmx: boolean;
};

export type V2Folder = { id: string; name: string; color: string | null; mailboxId: string; unread: number };

export type V2Counts = {
	inbox: number;
	spam: number;
	drafts: number;
	folders: Map<string, number>;
};

export type V2ListRow = {
	id: string;
	threadKey: string;
	mailboxId: string | null;
	direction: "inbound" | "outbound";
	status: string;
	folderId: string | null;
	fromAddr: string;
	toAddr: string;
	subject: string | null;
	snippet: string | null;
	createdAt: Date;
	read: boolean;
	starred: boolean;
	snoozedUntil: Date | null;
	hasAttachments: boolean;
	/** Messages in the conversation (all folders but trash). */
	count: number;
	unread: boolean;
	/** "Alice, me" style names of the conversation's senders, newest last. */
	participants: Array<{ name: string; unread: boolean }>;
	/** Ids this row stands for in the current view, so actions cover the whole conversation. */
	memberIds: string[];
};

export type V2ListPage = {
	rows: V2ListRow[];
	total: number;
	page: number;
	pageSize: number;
};

export type V2ThreadMessage = {
	id: string;
	mailboxId: string | null;
	direction: "inbound" | "outbound";
	status: string;
	folderId: string | null;
	fromAddr: string;
	fromName: string | null;
	toAddr: string;
	ccAddr: string | null;
	bccAddr: string | null;
	deliveredTo: string | null;
	subject: string | null;
	snippet: string | null;
	textBody: string | null;
	htmlBody: string | null;
	createdAt: Date;
	read: boolean;
	starred: boolean;
	providerMessageId: string | null;
	references: string | null;
	threadId: string | null;
	attachments: Array<{ id: string; filename: string; contentType: string; size: number; disposition: string; contentId: string | null }>;
};

export type V2Thread = {
	key: string;
	subject: string | null;
	messages: V2ThreadMessage[];
	mailboxId: string | null;
};

export type V2Session = { user: SessionUser };
