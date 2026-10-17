CREATE TABLE `cache_entries` (
	`key` text PRIMARY KEY NOT NULL,
	`model_slug` text NOT NULL,
	`upstream` text NOT NULL,
	`provider_id` text,
	`provider_name` text NOT NULL,
	`upstream_model` text NOT NULL,
	`payload` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cache_entries_expires_idx` ON `cache_entries` (`expires_at`);--> statement-breakpoint
CREATE INDEX `cache_entries_model_idx` ON `cache_entries` (`model_slug`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `cache_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `cache_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `cache_hit` integer DEFAULT false NOT NULL;