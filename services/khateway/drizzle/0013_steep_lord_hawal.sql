ALTER TABLE `models` ADD `sync_source` text;--> statement-breakpoint
ALTER TABLE `providers` ADD `auto_sync` integer DEFAULT false NOT NULL;