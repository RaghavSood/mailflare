import assert from "node:assert/strict";
import test from "node:test";

import {
	buildMessageCounts,
	getFolderBadgeCount,
	getFolderBadgeLabel,
} from "../src/app/api/messages/counts/utils.ts";

const base = { mailboxId: "mbx-1", folderId: null, starred: false, snoozedUntil: null };
const inbound = (read) => ({ ...base, direction: "inbound", status: "received", read });
const draft = () => ({ ...base, direction: "outbound", status: "draft", read: true });

test("inbox counts unread inbound mail", () => {
	const { folders } = buildMessageCounts([inbound(false), inbound(false), inbound(true)]);
	assert.equal(folders.inbox.total, 3);
	assert.equal(folders.inbox.unread, 2);
});

test("drafts are stored as read, so they are counted by total", () => {
	const { folders } = buildMessageCounts([draft(), draft(), inbound(false)]);
	assert.equal(folders.drafts.total, 2);
	assert.equal(folders.drafts.unread, 0);
	assert.equal(folders.inbox.unread, 1);
});

test("badge shows unread for inbox and the draft count for drafts", () => {
	const { folders } = buildMessageCounts([draft(), draft(), inbound(false), inbound(true)]);
	assert.equal(getFolderBadgeCount("inbox", folders), 1);
	assert.equal(getFolderBadgeCount("drafts", folders), 2);
	assert.equal(getFolderBadgeCount("sent", folders), 0);
});

test("badge labels name what is counted", () => {
	assert.equal(getFolderBadgeLabel("inbox", 3), "3 unread");
	assert.equal(getFolderBadgeLabel("drafts", 1), "1 draft");
	assert.equal(getFolderBadgeLabel("drafts", 2), "2 drafts");
});
