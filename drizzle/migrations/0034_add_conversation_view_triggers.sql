-- Keep conversation_views in step with messages (see 0033). Each trigger
-- recomputes the rows of the one conversation a write touched.
CREATE TRIGGER IF NOT EXISTS `messages_conversations_ai` AFTER INSERT ON `messages` WHEN new.mailbox_id IS NOT NULL BEGIN
	DELETE FROM conversation_views WHERE mailbox_id = new.mailbox_id AND thread_key = coalesce(new.thread_id, new.id);
	INSERT INTO conversation_views (mailbox_id, view, thread_key, latest_at, latest_id, message_count, unread_count, snooze_min)
	SELECT new.mailbox_id, v.view, coalesce(new.thread_id, new.id), max(v.created_at), v.id, count(*), sum(v.unread), CASE WHEN v.view = 'inbox' THEN (SELECT min(coalesce(s.snoozed_until, 0)) FROM messages s WHERE s.mailbox_id = new.mailbox_id AND coalesce(s.thread_id, s.id) = coalesce(new.thread_id, new.id) AND s.direction = 'inbound' AND s.status = 'received' AND s.folder_id IS NULL) ELSE 0 END
	FROM (
		SELECT CASE WHEN k.name = 'folder' THEN 'folder:' || m.folder_id ELSE k.name END AS view, m.id, m.created_at, (m.direction = 'inbound' AND m.read = 0) AS unread
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
		WHERE m.mailbox_id = new.mailbox_id AND coalesce(m.thread_id, m.id) = coalesce(new.thread_id, new.id)
	) v
	GROUP BY v.view;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `messages_conversations_ad` AFTER DELETE ON `messages` WHEN old.mailbox_id IS NOT NULL BEGIN
	DELETE FROM conversation_views WHERE mailbox_id = old.mailbox_id AND thread_key = coalesce(old.thread_id, old.id);
	INSERT INTO conversation_views (mailbox_id, view, thread_key, latest_at, latest_id, message_count, unread_count, snooze_min)
	SELECT old.mailbox_id, v.view, coalesce(old.thread_id, old.id), max(v.created_at), v.id, count(*), sum(v.unread), CASE WHEN v.view = 'inbox' THEN (SELECT min(coalesce(s.snoozed_until, 0)) FROM messages s WHERE s.mailbox_id = old.mailbox_id AND coalesce(s.thread_id, s.id) = coalesce(old.thread_id, old.id) AND s.direction = 'inbound' AND s.status = 'received' AND s.folder_id IS NULL) ELSE 0 END
	FROM (
		SELECT CASE WHEN k.name = 'folder' THEN 'folder:' || m.folder_id ELSE k.name END AS view, m.id, m.created_at, (m.direction = 'inbound' AND m.read = 0) AS unread
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
		WHERE m.mailbox_id = old.mailbox_id AND coalesce(m.thread_id, m.id) = coalesce(old.thread_id, old.id)
	) v
	GROUP BY v.view;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `messages_conversations_au_new` AFTER UPDATE OF `thread_id`, `mailbox_id`, `status`, `folder_id`, `direction`, `read`, `starred`, `snoozed_until`, `created_at` ON `messages` WHEN new.mailbox_id IS NOT NULL BEGIN
	DELETE FROM conversation_views WHERE mailbox_id = new.mailbox_id AND thread_key = coalesce(new.thread_id, new.id);
	INSERT INTO conversation_views (mailbox_id, view, thread_key, latest_at, latest_id, message_count, unread_count, snooze_min)
	SELECT new.mailbox_id, v.view, coalesce(new.thread_id, new.id), max(v.created_at), v.id, count(*), sum(v.unread), CASE WHEN v.view = 'inbox' THEN (SELECT min(coalesce(s.snoozed_until, 0)) FROM messages s WHERE s.mailbox_id = new.mailbox_id AND coalesce(s.thread_id, s.id) = coalesce(new.thread_id, new.id) AND s.direction = 'inbound' AND s.status = 'received' AND s.folder_id IS NULL) ELSE 0 END
	FROM (
		SELECT CASE WHEN k.name = 'folder' THEN 'folder:' || m.folder_id ELSE k.name END AS view, m.id, m.created_at, (m.direction = 'inbound' AND m.read = 0) AS unread
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
		WHERE m.mailbox_id = new.mailbox_id AND coalesce(m.thread_id, m.id) = coalesce(new.thread_id, new.id)
	) v
	GROUP BY v.view;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `messages_conversations_au_old` AFTER UPDATE OF `thread_id`, `mailbox_id`, `status`, `folder_id`, `direction`, `read`, `starred`, `snoozed_until`, `created_at` ON `messages`
WHEN old.mailbox_id IS NOT NULL AND (new.mailbox_id IS NOT old.mailbox_id OR coalesce(new.thread_id, new.id) IS NOT coalesce(old.thread_id, old.id)) BEGIN
	DELETE FROM conversation_views WHERE mailbox_id = old.mailbox_id AND thread_key = coalesce(old.thread_id, old.id);
	INSERT INTO conversation_views (mailbox_id, view, thread_key, latest_at, latest_id, message_count, unread_count, snooze_min)
	SELECT old.mailbox_id, v.view, coalesce(old.thread_id, old.id), max(v.created_at), v.id, count(*), sum(v.unread), CASE WHEN v.view = 'inbox' THEN (SELECT min(coalesce(s.snoozed_until, 0)) FROM messages s WHERE s.mailbox_id = old.mailbox_id AND coalesce(s.thread_id, s.id) = coalesce(old.thread_id, old.id) AND s.direction = 'inbound' AND s.status = 'received' AND s.folder_id IS NULL) ELSE 0 END
	FROM (
		SELECT CASE WHEN k.name = 'folder' THEN 'folder:' || m.folder_id ELSE k.name END AS view, m.id, m.created_at, (m.direction = 'inbound' AND m.read = 0) AS unread
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
		WHERE m.mailbox_id = old.mailbox_id AND coalesce(m.thread_id, m.id) = coalesce(old.thread_id, old.id)
	) v
	GROUP BY v.view;
END;
