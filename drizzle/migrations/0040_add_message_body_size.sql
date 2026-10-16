-- UTF-8 byte length of text_body plus html_body, so JMAP Email/get can answer
-- `size` for a message list without reading the bodies. Triggers keep it in
-- step with every insert and every body edit, whichever code path writes, and
-- the backfill fills existing rows. Casting text to a blob yields its UTF-8
-- bytes, the same count TextEncoder gives. body_size is in no other trigger's
-- UPDATE OF list (FTS 0030, change log 0033, conversation views 0034), and not
-- in its own, so setting it fires nothing and cannot recurse.
ALTER TABLE `messages` ADD `body_size` integer;--> statement-breakpoint
CREATE TRIGGER `messages_body_size_ai` AFTER INSERT ON `messages` BEGIN
	UPDATE `messages` SET `body_size` = length(CAST(coalesce(new.`text_body`, '') AS BLOB)) + length(CAST(coalesce(new.`html_body`, '') AS BLOB))
	WHERE `rowid` = new.`rowid`;
END;--> statement-breakpoint
CREATE TRIGGER `messages_body_size_au` AFTER UPDATE OF `text_body`, `html_body` ON `messages` BEGIN
	UPDATE `messages` SET `body_size` = length(CAST(coalesce(new.`text_body`, '') AS BLOB)) + length(CAST(coalesce(new.`html_body`, '') AS BLOB))
	WHERE `rowid` = new.`rowid`;
END;--> statement-breakpoint
UPDATE `messages` SET `body_size` = length(CAST(coalesce(`text_body`, '') AS BLOB)) + length(CAST(coalesce(`html_body`, '') AS BLOB));
