// The upstream wire dialects Khateway speaks, shared by worker and web
// (dependency-free so the SPA can import it without Workers types).
// `gemini` is Google's native generateContent dialect (M12) — it is never a
// client-facing dialect; every gemini pairing is translated.
export type Adapter = 'openai' | 'anthropic' | 'gemini';

/** Adapters a provider may declare, in gateway preference order. */
export const KNOWN_ADAPTERS: readonly Adapter[] = ['openai', 'anthropic', 'gemini'];
