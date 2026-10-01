-- Fill conversation_views from the messages already stored (see 0033).
INSERT OR REPLACE INTO conversation_views (mailbox_id, view, thread_key, latest_at, latest_id, message_count, unread_count, snooze_min)
SELECT v.mailbox_id, v.view, v.thread_key, max(v.created_at), v.id, count(*), sum(v.unread), 0
FROM (
	SELECT m.mailbox_id, coalesce(m.thread_id, m.id) AS thread_key, CASE WHEN k.name = 'folder' THEN 'folder:' || m.folder_id ELSE k.name END AS view, m.id, m.created_at, (m.direction = 'inbound' AND m.read = 0) AS unread
	FROM messages m JOIN conversation_view_kinds k ON (
			(k.name = 'inbox' AND m.direction = 'inbound' AND m.status = 'received' AND m.folder_id IS NULL)
			OR (k.name = 'sent' AND m.direction = 'outbound' AND m.status IN ('sent', 'queued'))
			OR (k.name = 'archive' AND m.status = 'archived')
			OR (k.name = 'spam' AND m.status = 'spam')
			OR (k.name = 'trash' AND m.status = 'trash')
			OR (k.name = 'all' AND m.status NOT IN ('draft', 'spam', 'trash'))
			OR (k.name = 'starred' AND m.starred = 1 AND m.status NOT IN ('draft', 'spam', 'trash'))
			OR (k.name = 'folder' AND m.folder_id IS NOT NULL AND m.status NOT IN ('draft', 'spam', 'trash'))
		)
	WHERE m.mailbox_id IS NOT NULL
) v
GROUP BY v.mailbox_id, v.thread_key, v.view;--> statement-breakpoint
-- One grouped pass; a subquery correlated with each row cannot use the
-- thread index and scans messages once per conversation.
UPDATE conversation_views SET snooze_min = s.snooze_min
FROM (
	SELECT mailbox_id, coalesce(thread_id, id) AS thread_key, min(coalesce(snoozed_until, 0)) AS snooze_min
	FROM messages
	WHERE mailbox_id IS NOT NULL AND direction = 'inbound' AND status = 'received' AND folder_id IS NULL
	GROUP BY mailbox_id, coalesce(thread_id, id)
) s
WHERE conversation_views.view = 'inbox'
	AND conversation_views.mailbox_id = s.mailbox_id
	AND conversation_views.thread_key = s.thread_key;
