-- Web Push subscriptions. One row per browser endpoint, bound to the user and
-- the session that subscribed it: signing out (or any path that deletes the
-- session) removes the row with it. `vapid_key_id` names the server key the
-- browser subscribed with, so rows left behind by a key change are dropped.
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE cascade,
	`vapid_key_id` text NOT NULL,
	`endpoint` text NOT NULL UNIQUE,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`failed_at` integer
);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_session_idx` ON `push_subscriptions` (`session_id`);
