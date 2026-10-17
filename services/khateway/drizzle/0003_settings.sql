-- Deployment-level settings (admin-controlled gateway behavior).
-- Rows: 'client_key_enforcement' = 'on' | 'off' (absent = 'off' = keyless-native default).
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
