-- The composer that wrote a draft, as a key the browser makes up for each
-- composer and sends with every save and send. A save or send that does not
-- know its draft id yet (the first one, or a replay of it whose response was
-- lost) finds the draft by this key instead of creating a second one, and the
-- sent copy keeps the key, so a replay after the message went out is refused.
-- No trigger watches this column.
ALTER TABLE `messages` ADD `compose_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_compose_key_draft_idx` ON `messages` (`user_id`, `compose_key`) WHERE `compose_key` IS NOT NULL AND `status` = 'draft';--> statement-breakpoint
CREATE INDEX `messages_compose_key_idx` ON `messages` (`user_id`, `compose_key`) WHERE `compose_key` IS NOT NULL;
