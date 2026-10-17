// Unit tests for joinAdapterUrl (env.ts): the single rule that lets one
// provider base URL serve both upstream adapters regardless of whether the
// user pasted it with or without /v1. These cases are the contract — adapters,
// admin test-connection, and model discovery all route through this function.
import { describe, expect, it } from 'vitest';
import { joinAdapterUrl } from '../../src/worker/env';

const CHAT = '/chat/completions';
const MESSAGES = '/v1/messages';
const MODELS = '/models';
const ANTHROPIC_MODELS = '/v1/models';

describe('joinAdapterUrl — base URL pasted WITH /v1', () => {
  it('openai keeps the /v1 base as-is', () => {
    expect(joinAdapterUrl('https://openrouter.ai/api/v1', 'openai', CHAT)).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('anthropic strips the trailing /v1 before appending /v1/messages (no /v1/v1)', () => {
    expect(joinAdapterUrl('https://openrouter.ai/api/v1', 'anthropic', MESSAGES)).toBe('https://openrouter.ai/api/v1/messages');
  });

  it('trailing slashes on the base are tolerated', () => {
    expect(joinAdapterUrl('https://openrouter.ai/api/v1/', 'openai', CHAT)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(joinAdapterUrl('https://openrouter.ai/api/v1/', 'anthropic', MESSAGES)).toBe('https://openrouter.ai/api/v1/messages');
  });
});

describe('joinAdapterUrl — base URL pasted WITHOUT /v1 (bare origin)', () => {
  it('anthropic keeps the bare origin (official Anthropic convention)', () => {
    expect(joinAdapterUrl('https://api.anthropic.com', 'anthropic', MESSAGES)).toBe('https://api.anthropic.com/v1/messages');
  });

  it('openai inserts /v1 on bare origins', () => {
    expect(joinAdapterUrl('https://api.anthropic.com', 'openai', CHAT)).toBe('https://api.anthropic.com/v1/chat/completions');
    expect(joinAdapterUrl('http://localhost:4000', 'openai', CHAT)).toBe('http://localhost:4000/v1/chat/completions');
  });
});

describe('joinAdapterUrl — vendor bases with a custom path must never gain /v1', () => {
  it('z.ai coding endpoint (no trailing /v1) is left untouched for openai', () => {
    expect(joinAdapterUrl('https://api.z.ai/api/coding/paas/v4', 'openai', CHAT)).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
  });

  it('Gemini-compat endpoint keeps its odd path', () => {
    expect(joinAdapterUrl('https://generativelanguage.googleapis.com/v1beta/openai', 'openai', CHAT)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
  });

  it('origin + path that already ends in v1 is kept verbatim (not doubled)', () => {
    expect(joinAdapterUrl('https://gateway.example.com/api/v1', 'openai', CHAT)).toBe('https://gateway.example.com/api/v1/chat/completions');
  });
});

describe('joinAdapterUrl — /models discovery paths follow the same rule', () => {
  it('openai-style /models on a /v1 base', () => {
    expect(joinAdapterUrl('https://api.example.com/v1', 'openai', MODELS)).toBe('https://api.example.com/v1/models');
  });

  it('anthropic /v1/models on a bare origin', () => {
    expect(joinAdapterUrl('https://api.example.com', 'anthropic', ANTHROPIC_MODELS)).toBe('https://api.example.com/v1/models');
  });

  it('anthropic /v1/models on a pasted /v1 base (stripped, not doubled)', () => {
    expect(joinAdapterUrl('https://api.example.com/v1', 'anthropic', ANTHROPIC_MODELS)).toBe('https://api.example.com/v1/models');
  });
});

describe('joinAdapterUrl — gemini (M12): generateContent paths under /v1beta', () => {
  const GENERATE = '/models/gemini-2.5-flash:generateContent';

  it('a bare origin gains /v1beta (mirrors the openai bare-origin rule)', () => {
    expect(joinAdapterUrl('https://generativelanguage.googleapis.com', 'gemini', GENERATE)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
  });

  it('a pasted /v1beta base is kept as-is (the canonical Gemini REST root)', () => {
    expect(joinAdapterUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini', GENERATE)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
  });

  it('streaming action with query string joins verbatim', () => {
    expect(joinAdapterUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini', '/models/gemini-2.5-flash:streamGenerateContent?alt=sse')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
  });

  it('custom proxy paths are never modified (conservative like the other adapters)', () => {
    expect(joinAdapterUrl('https://proxy.example.com/gem', 'gemini', GENERATE)).toBe('https://proxy.example.com/gem/models/gemini-2.5-flash:generateContent');
  });

  it('trailing /v1 is NOT stripped for gemini (that rule is anthropic-only — user error surfaces honestly)', () => {
    expect(joinAdapterUrl('https://api.example.com/v1', 'gemini', GENERATE)).toBe('https://api.example.com/v1/models/gemini-2.5-flash:generateContent');
  });
});
