-- Conversation summaries for the v2 lists. One row per mailbox, view and
-- conversation (thread_id, or the message id for unthreaded mail) with its
-- newest message in that view, so a list page is one indexed range read instead
-- of grouping every message. Triggers keep it in step with every write, as
-- messages_fts is kept, so no code path has to remember to update it. Both
-- tables are derived: backups skip them and a restore rebuilds them through
-- the triggers. A bare id column alongside max(created_at) is SQLite's
-- documented way to take the row holding the maximum.
CREATE TABLE `conversation_view_kinds` (
	`name` text PRIMARY KEY NOT NULL
);--> statement-breakpoint
INSERT INTO `conversation_view_kinds` (`name`) VALUES ('inbox'), ('sent'), ('archive'), ('spam'), ('trash'), ('all'), ('starred'), ('folder');--> statement-breakpoint
CREATE TABLE `conversation_views` (
	`mailbox_id` text NOT NULL REFERENCES `mailboxes`(`id`) ON DELETE cascade,
	`view` text NOT NULL,
	`thread_key` text NOT NULL,
	`latest_at` integer NOT NULL,
	`latest_id` text NOT NULL,
	`message_count` integer NOT NULL,
	`unread_count` integer NOT NULL,
	`snooze_min` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY (`mailbox_id`, `view`, `thread_key`)
);--> statement-breakpoint
CREATE INDEX `conversation_views_list_idx` ON `conversation_views` (`mailbox_id`, `view`, `latest_at`, `latest_id`);--> statement-breakpoint
CREATE INDEX `conversation_views_thread_idx` ON `conversation_views` (`mailbox_id`, `thread_key`);--> statement-breakpoint
CREATE INDEX `conversation_views_unread_idx` ON `conversation_views` (`mailbox_id`, `view`) WHERE `unread_count` > 0;--> statement-breakpoint
CREATE INDEX `messages_mailbox_thread_key_idx` ON `messages` (`mailbox_id`, coalesce(`thread_id`, `id`), `created_at`);--> statement-breakpoint
CREATE INDEX `messages_mailbox_status_created_idx` ON `messages` (`mailbox_id`, `status`, `created_at`);--> statement-breakpoint
CREATE TRIGGER `messages_conversations_ai` AFTER INSERT ON `messages` WHEN new.mailbox_id IS NOT NULL BEGIN
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
CREATE TRIGGER `messages_conversations_ad` AFTER DELETE ON `messages` WHEN old.mailbox_id IS NOT NULL BEGIN
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
CREATE TRIGGER `messages_conversations_au_new` AFTER UPDATE OF `thread_id`, `mailbox_id`, `status`, `folder_id`, `direction`, `read`, `starred`, `snoozed_until`, `created_at` ON `messages` WHEN new.mailbox_id IS NOT NULL BEGIN
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
CREATE TRIGGER `messages_conversations_au_old` AFTER UPDATE OF `thread_id`, `mailbox_id`, `status`, `folder_id`, `direction`, `read`, `starred`, `snoozed_until`, `created_at` ON `messages`
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
END;--> statement-breakpoint
INSERT INTO conversation_views (mailbox_id, view, thread_key, latest_at, latest_id, message_count, unread_count, snooze_min)
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
UPDATE conversation_views SET snooze_min = (
	SELECT min(coalesce(s.snoozed_until, 0)) FROM messages s
	WHERE s.mailbox_id = conversation_views.mailbox_id AND coalesce(s.thread_id, s.id) = conversation_views.thread_key
		AND s.direction = 'inbound' AND s.status = 'received' AND s.folder_id IS NULL
) WHERE view = 'inbox';
