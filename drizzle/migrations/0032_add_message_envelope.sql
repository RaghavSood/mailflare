-- SMTP envelope recipient and sender of inbound and imported messages.
ALTER TABLE `messages` ADD `delivered_to` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `envelope_from` text;
