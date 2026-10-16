// Shared vendor URL presets for the provider forms (worker + web import it).
// Data only — no dependencies, no secrets. Every entry satisfies its declared
// adapters under one base URL thanks to `joinAdapterUrl` (env.ts): a trailing
// `/v1` is kept for openai and stripped for anthropic; a bare origin is kept
// for anthropic and gains `/v1` for openai. Both paste styles are valid, so
// presets are stored in each vendor's canonical/most common form.
import type { Adapter } from './adapters';

export interface VendorPreset {
  /** Canonical vendor name shown in the picker. */
  name: string;
  /** Base URL to write into the provider form verbatim. */
  baseUrl: string;
  /** Adapters the vendor is known to serve at this URL (drives the checkbox UI). */
  adapters: Adapter[];
  /** Short picker caption, e.g. which adapters this URL serves. */
  hint: string;
}

/**
 * Curated presets. Dual-dialect entries carry the openai-convention base
 * (with `/v1`) — verified against vendor docs: OpenRouter serves
 * POST /api/v1/chat/completions AND POST /api/v1/messages from the same
 * server URL; LiteLLM serves /v1/chat/completions and /v1/messages.
 */
export const VENDOR_PRESETS: VendorPreset[] = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapters: ['openai'], hint: 'Chat Completions · official' },
  { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', adapters: ['anthropic'], hint: 'Messages · official (no /v1)' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', adapters: ['openai', 'anthropic'], hint: 'Both dialects on one URL' },
  { name: 'LiteLLM proxy', baseUrl: 'http://localhost:4000/v1', adapters: ['openai', 'anthropic'], hint: 'Both dialects on one URL' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', adapters: ['openai'], hint: 'OpenAI-compatible' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', adapters: ['openai'], hint: 'OpenAI-compatible · free tier' },
  { name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', adapters: ['openai'], hint: 'OpenAI-compatible · free with PAT' },
  { name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', adapters: ['openai'], hint: 'OpenAI-compatible · free tier' },
  { name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', adapters: ['openai'], hint: 'OpenAI-compatible · free tier' },
  { name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', adapters: ['openai'], hint: 'OpenAI-compatible · free credits' },
  { name: 'Pollinations', baseUrl: 'https://text.pollinations.ai/openai', adapters: ['openai'], hint: 'OpenAI-compatible · keyless free' },
  { name: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', adapters: ['openai'], hint: 'OpenAI-compatible' },
  { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', adapters: ['openai'], hint: 'OpenAI-compatible' },
  { name: 'Together', baseUrl: 'https://api.together.xyz/v1', adapters: ['openai'], hint: 'OpenAI-compatible' },
  { name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', adapters: ['openai'], hint: 'OpenAI-compatible · local' },
  { name: 'Gemini (OpenAI-compat)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', adapters: ['openai'], hint: 'OpenAI-compatible endpoint' },
  { name: 'Gemini (native)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', adapters: ['gemini'], hint: 'generateContent · native adapter' },
  { name: 'z.ai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', adapters: ['openai'], hint: 'Coding-plan endpoint' },
];
