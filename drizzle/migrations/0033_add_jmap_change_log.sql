-- JMAP change log. Triggers append one row for every insert, update and delete
-- on messages and folders, whichever code path writes, so the JMAP /changes
-- methods can answer from it instead of cannotCalculateChanges. The sequence
-- is AUTOINCREMENT so a pruned row's number is never reused and states only
-- ever move forward.
CREATE TABLE `jmap_change_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`object_id` text NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text,
	`thread_key` text,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `jmap_change_log_mailbox_seq_idx` ON `jmap_change_log` (`mailbox_id`,`seq`);--> statement-breakpoint
CREATE INDEX `jmap_change_log_user_seq_idx` ON `jmap_change_log` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `jmap_change_log_created_idx` ON `jmap_change_log` (`created_at`);--> statement-breakpoint
CREATE TRIGGER `jmap_change_log_messages_ai` AFTER INSERT ON `messages` BEGIN
	INSERT INTO `jmap_change_log` (`type`, `object_id`, `user_id`, `mailbox_id`, `thread_key`, `kind`, `created_at`)
	VALUES ('email', new.`id`, new.`user_id`, new.`mailbox_id`, coalesce(new.`thread_id`, new.`id`), 'created', cast(strftime('%s', 'now') AS integer));
END;--> statement-breakpoint
CREATE TRIGGER `jmap_change_log_messages_au` AFTER UPDATE OF `mailbox_id`, `folder_id`, `status`, `read`, `starred`, `thread_id`, `subject`, `from_addr`, `to_addr`, `cc_addr`, `bcc_addr`, `text_body`, `html_body`, `in_reply_to`, `references_header`, `created_at` ON `messages`
WHEN old.`mailbox_id` IS NOT new.`mailbox_id`
	OR old.`folder_id` IS NOT new.`folder_id`
	OR old.`status` IS NOT new.`status`
	OR old.`read` IS NOT new.`read`
	OR old.`starred` IS NOT new.`starred`
	OR old.`thread_id` IS NOT new.`thread_id`
	OR old.`subject` IS NOT new.`subject`
	OR old.`from_addr` IS NOT new.`from_addr`
	OR old.`to_addr` IS NOT new.`to_addr`
	OR old.`cc_addr` IS NOT new.`cc_addr`
	OR old.`bcc_addr` IS NOT new.`bcc_addr`
	OR old.`text_body` IS NOT new.`text_body`
	OR old.`html_body` IS NOT new.`html_body`
	OR old.`in_reply_to` IS NOT new.`in_reply_to`
	OR old.`references_header` IS NOT new.`references_header`
	OR old.`created_at` IS NOT new.`created_at`
BEGIN
	INSERT INTO `jmap_change_log` (`type`, `object_id`, `user_id`, `mailbox_id`, `thread_key`, `kind`, `created_at`)
	VALUES ('email', new.`id`, new.`user_id`, new.`mailbox_id`, coalesce(new.`thread_id`, new.`id`), 'updated', cast(strftime('%s', 'now') AS integer));
	INSERT INTO `jmap_change_log` (`type`, `object_id`, `user_id`, `mailbox_id`, `thread_key`, `kind`, `created_at`)
	SELECT 'email', old.`id`, old.`user_id`, old.`mailbox_id`, coalesce(old.`thread_id`, old.`id`),
		CASE WHEN old.`mailbox_id` IS NOT new.`mailbox_id` THEN 'destroyed' ELSE 'updated' END,
		cast(strftime('%s', 'now') AS integer)
	WHERE old.`mailbox_id` IS NOT new.`mailbox_id` OR coalesce(old.`thread_id`, old.`id`) IS NOT coalesce(new.`thread_id`, new.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `jmap_change_log_messages_ad` AFTER DELETE ON `messages` BEGIN
	INSERT INTO `jmap_change_log` (`type`, `object_id`, `user_id`, `mailbox_id`, `thread_key`, `kind`, `created_at`)
	VALUES ('email', old.`id`, old.`user_id`, old.`mailbox_id`, coalesce(old.`thread_id`, old.`id`), 'destroyed', cast(strftime('%s', 'now') AS integer));
END;--> statement-breakpoint
CREATE TRIGGER `jmap_change_log_folders_ai` AFTER INSERT ON `folders` BEGIN
	INSERT INTO `jmap_change_log` (`type`, `object_id`, `user_id`, `mailbox_id`, `thread_key`, `kind`, `created_at`)
	VALUES ('mailbox', new.`id`, new.`user_id`, new.`mailbox_id`, NULL, 'created', cast(strftime('%s', 'now') AS integer));
END;--> statement-breakpoint
CREATE TRIGGER `jmap_change_log_folders_au` AFTER UPDATE OF `name`, `mailbox_id` ON `folders`
WHEN old.`name` IS NOT new.`name` OR old.`mailbox_id` IS NOT new.`mailbox_id`
BEGIN
	INSERT INTO `jmap_change_log` (`type`, `object_id`, `user_id`, `mailbox_id`, `thread_key`, `kind`, `created_at`)
	VALUES ('mailbox', new.`id`, new.`user_id`, new.`mailbox_id`, NULL, 'updated', cast(strftime('%s', 'now') AS integer));
END;--> statement-breakpoint
CREATE TRIGGER `jmap_change_log_folders_ad` AFTER DELETE ON `folders` BEGIN
	INSERT INTO `jmap_change_log` (`type`, `object_id`, `user_id`, `mailbox_id`, `thread_key`, `kind`, `created_at`)
	VALUES ('mailbox', old.`id`, old.`user_id`, old.`mailbox_id`, NULL, 'destroyed', cast(strftime('%s', 'now') AS integer));
END;
