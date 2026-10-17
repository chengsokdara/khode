-- providers.adapter ('openai' | 'anthropic') → providers.adapters (JSON array)
-- so one provider can speak several upstream dialects (dual-dialect endpoints
-- like OpenRouter/LiteLLM/Cloudflare AI Gateway). Backfills every existing row
-- from the legacy scalar column, then drops it.
ALTER TABLE `providers` ADD `adapters` text NOT NULL DEFAULT '["openai"]';--> statement-breakpoint
UPDATE `providers` SET `adapters` = json_array(`adapter`) WHERE `adapter` IN ('openai', 'anthropic');--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `adapter`;
