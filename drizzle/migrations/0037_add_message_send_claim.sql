-- Set on a draft while a send of it is in flight, so a second request for the
-- same draft (a replayed send whose first response was lost) cannot send it
-- again. No trigger watches this column, and the draft keeps status 'draft'.
ALTER TABLE `messages` ADD `send_claimed_at` integer;
