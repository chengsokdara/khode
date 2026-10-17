CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`spend_limit_usd` real,
	`allowed_models` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`slug` text NOT NULL,
	`upstream_model` text,
	`display_name` text,
	`context_window` integer,
	`max_output_tokens` integer,
	`pricing_input` real,
	`pricing_output` real,
	`capabilities` text,
	`fallbacks` text,
	`base_url_override` text,
	`api_key_override_enc` text,
	`key_hint` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_slug_unique` ON `models` (`slug`);--> statement-breakpoint
CREATE INDEX `models_provider_idx` ON `models` (`provider_id`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`adapter` text NOT NULL,
	`base_url` text,
	`api_key_enc` text,
	`key_hint` text,
	`default_headers` text,
	`timeout_ms` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text,
	`model_slug` text NOT NULL,
	`provider_id` text,
	`upstream_model` text,
	`dialect` text NOT NULL,
	`status` integer NOT NULL,
	`latency_ms` integer,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost_usd` real,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `request_logs_created_idx` ON `request_logs` (`created_at`);