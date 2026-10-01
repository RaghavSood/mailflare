-- Conversation summaries for the v2 lists. One row per mailbox, view and
-- conversation (thread_id, or the message id for unthreaded mail) with its
-- newest message in that view, so a list page is one indexed range read instead
-- of grouping every message. Triggers keep it in step with every write, as
-- messages_fts is kept, so no code path has to remember to update it. Both
-- tables are derived: backups skip them and a restore rebuilds them through
-- the triggers. A bare id column alongside max(created_at) is SQLite's
-- documented way to take the row holding the maximum.
CREATE TABLE IF NOT EXISTS `conversation_view_kinds` (
	`name` text PRIMARY KEY NOT NULL
);--> statement-breakpoint
INSERT OR IGNORE INTO `conversation_view_kinds` (`name`) VALUES ('inbox'), ('sent'), ('archive'), ('spam'), ('trash'), ('all'), ('starred'), ('folder');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conversation_views` (
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
CREATE INDEX IF NOT EXISTS `conversation_views_list_idx` ON `conversation_views` (`mailbox_id`, `view`, `latest_at`, `latest_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `conversation_views_thread_idx` ON `conversation_views` (`mailbox_id`, `thread_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `conversation_views_unread_idx` ON `conversation_views` (`mailbox_id`, `view`) WHERE `unread_count` > 0;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_mailbox_thread_key_idx` ON `messages` (`mailbox_id`, coalesce(`thread_id`, `id`), `created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_mailbox_status_created_idx` ON `messages` (`mailbox_id`, `status`, `created_at`);
