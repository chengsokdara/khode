CREATE TABLE `org_members` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_members_org_user_unique` ON `org_members` (`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `org_members_user_idx` ON `org_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`join_code` text NOT NULL,
	`balance_usd_micros` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orgs_join_code_unique` ON `orgs` (`join_code`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_balance_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`org_id` text,
	`delta_usd_micros` integer NOT NULL,
	`kind` text NOT NULL,
	`ref` text,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_balance_entries`("id", "user_id", "org_id", "delta_usd_micros", "kind", "ref", "note", "created_at") SELECT "id", "user_id", "org_id", "delta_usd_micros", "kind", "ref", "note", "created_at" FROM `balance_entries`;--> statement-breakpoint
DROP TABLE `balance_entries`;--> statement-breakpoint
ALTER TABLE `__new_balance_entries` RENAME TO `balance_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `balance_entries_user_idx` ON `balance_entries` (`user_id`);--> statement-breakpoint
CREATE INDEX `balance_entries_org_idx` ON `balance_entries` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_ref_unique` ON `balance_entries` (`ref`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `org_id` text;--> statement-breakpoint
CREATE INDEX `api_keys_org_idx` ON `api_keys` (`org_id`);--> statement-breakpoint
ALTER TABLE `request_logs` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `org_id` text;--> statement-breakpoint
CREATE INDEX `request_logs_org_idx` ON `request_logs` (`org_id`);--> statement-breakpoint
CREATE INDEX `request_logs_user_idx` ON `request_logs` (`user_id`);