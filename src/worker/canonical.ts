/**
 * Canonical intermediate form of chat requests, shared by client-dialect
 * parsers (`dialects/`) and upstream adapters (`adapters/`). Types only —
 * per the module boundary rules (RULES.md #7) all triage/translation logic
 * lives in dialects/, adapters/ and routes/gateway*.
 *
 * M6 scope: text + vision (images) + tool calling. Tool arguments are carried
 * in their openai wire encoding (a JSON *string*) because both other dialects
 * convert to/from it losslessly; tool inputs are objects on the anthropic wire
 * and strings on the responses wire. Images carry a URL — a `data:` URL or an
 * https URL — which every dialect can express (anthropic base64 blocks are
 * built from data URLs at adapter time).
 */

/** Roles representable canonically. `tool` messages carry a tool result. */
export type CanonicalRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface CanonicalImage {
  /** `data:image/png;base64,…` or `https://…` URL. */
  url: string;
  /** OpenAI-only rendering hint carried through openai-shaped requests. */
  detail?: 'auto' | 'low' | 'high';
}

/** One assistant tool invocation (openai `tool_calls[]` / anthropic `tool_use` / responses `function_call`). */
export interface CanonicalToolCall {
  /** openai tool_call id / anthropic tool_use id / responses call_id — the binding key. */
  id: string;
  name: string;
  /** JSON text of the arguments (openai wire encoding). */
  arguments: string;
}

export interface CanonicalMessage {
  role: CanonicalRole;
  /** Folded plain text content (multi-part text arrays are joined with '\n'). */
  content: string;
  /** Images attached to this message (vision); emitted after the folded text in translated requests. */
  images?: CanonicalImage[];
  /** Assistant tool invocations (role 'assistant'). */
  toolCalls?: CanonicalToolCall[];
  /** Tool result binding (role 'tool'): the tool-call id this message answers. */
  toolCallId?: string;
  /** M17 reasoning content carried in conversation history (anthropic thinking
   * blocks, openai `reasoning_content`, responses reasoning items). Only
   * re-emitted to upstreams that can express it (anthropic thinking blocks —
   * with signature; dropped for openai/gemini histories — reasoning is never
   * required to continue a conversation). */
  reasoning?: CanonicalReasoningContent;
  /** P1: anthropic prompt-cache marker folded from the message's content blocks (see CanonicalCacheControl). */
  cacheControl?: CanonicalCacheControl;
  /** Per-message client fields Khateway does not interpret (e.g. `name`); kept for passthrough. */
  extra: Record<string, unknown>;
}

/** M17: reasoning content attached to a message. */
export interface CanonicalReasoningContent {
  /** Visible thinking text. */
  text?: string;
  /** Anthropic thinking signature — preserved verbatim for anthropic upstreams (API requirement). */
  signature?: string;
  /** Anthropic redacted_thinking data — preserved verbatim, only re-emitted to anthropic. */
  redacted?: string;
}

/**
 * P1: Anthropic prompt-caching marker, parsed from `cache_control` on
 * anthropic content blocks / system blocks / tool definitions. Anthropic marks
 * a cache breakpoint PER BLOCK while Khateway folds multi-part text into one
 * string per message — so the flag folds to the message level (last marked
 * block wins, the documented "mark the last block" convention). Re-emitted on
 * the anthropic wire (text block, or the turn's last block when there is no
 * text; tool_result blocks; tool defs; system blocks); openai/gemini adapters
 * drop it (their caching is implicit/automatic, no client control).
 */
export interface CanonicalCacheControl {
  type: 'ephemeral';
  /** Anthropic cache TTL; absent = the 5-minute default. */
  ttl?: '5m' | '1h';
}

/**
 * M17: request-level reasoning/thinking control, normalized from the openai
 * `reasoning_effort` param, the anthropic `thinking` param (budget_tokens)
 * and the responses `reasoning` param. Adapters map it per target dialect.
 */
export interface CanonicalReasoning {
  /** Client-declared effort bucket ('minimal' = as little as possible — gemini disables thinking). */
  effort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Explicit token budget (anthropic budget_tokens). Wins over effort when set. */
  budgetTokens?: number;
}

/** A client-declared callable tool (openai `function` / anthropic tool / responses function tool). */
export interface CanonicalToolDef {
  name: string;
  description?: string;
  /** JSON Schema object describing the arguments (openai `parameters` / anthropic `input_schema`). */
  parameters?: unknown;
  /** P1: anthropic prompt-cache marker on the tool definition (anthropic dialect only). */
  cacheControl?: CanonicalCacheControl;
}

/** openai `tool_choice` / anthropic `tool_choice` / responses `tool_choice`, normalized. */
export type CanonicalToolChoice = 'auto' | 'none' | 'required' | { name: string };

/** Generation parameters Khateway understands in every dialect; everything else rides in `extras`. */
export interface CanonicalChatOptions {
  temperature?: number | null;
  topP?: number | null;
  /** Token limit; kept with its source field so adapters emit the right one (`max_completion_tokens` for reasoning models). */
  maxTokens?: number | null;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  stop?: string[] | null;
  n?: number | null;
  /** Callable tools offered to the model. */
  tools?: CanonicalToolDef[] | null;
  toolChoice?: CanonicalToolChoice | null;
  /** Allow the model to emit several tool calls per turn (openai/responses native; anthropic models it as disable_parallel_tool_use). */
  parallelToolCalls?: boolean | null;
}

/**
 * M18: structured-output / JSON-mode control, normalized from the openai chat
 * `response_format` param and the responses `text.format` param. Adapters map
 * it per target dialect (openai re-emits verbatim; gemini responseMimeType +
 * responseSchema; anthropic a best-effort system directive).
 */
export interface CanonicalResponseFormat {
  type: 'json_object' | 'json_schema';
  /** json_schema only: the declared schema name. */
  name?: string;
  /** json_schema only: the JSON Schema the output must conform to. */
  schema?: unknown;
  /** json_schema only: strict mode wish (adapters interpret per dialect). */
  strict?: boolean;
}

export interface CanonicalChatRequest {
  messages: CanonicalMessage[];
  stream: boolean;
  /** openai `stream_options.include_usage` verbatim when the client declared it (openai chat dialect only). */
  streamIncludeUsage?: boolean;
  /** M17: reasoning/thinking control normalized from the three client dialects. */
  reasoning?: CanonicalReasoning | null;
  /** M18: JSON mode / structured outputs, null/absent = plain text. */
  responseFormat?: CanonicalResponseFormat | null;
  options: CanonicalChatOptions;
  /** Client fields Khateway does not interpret; adapters pass them through where the upstream dialect allows. */
  extras: Record<string, unknown>;
}

/**
 * Canonical embeddings request (M13) — the first non-chat pipeline shape. The
 * only client face is the OpenAI `/v1/embeddings` API (Anthropic has no
 * embeddings endpoint), so this form is parsed from openai wire shapes and
 * served by the openai-compatible upstream adapter (relayed) or the native
 * Gemini adapter (`:embedContent` / `:batchEmbedContents`).
 */
export interface CanonicalEmbeddingsRequest {
  /** Texts to embed, normalized to an array (a lone string input becomes [input]). */
  input: string[];
  /** openai `dimensions` — truncated output dimensionality, when the client sent it. */
  dimensions?: number | null;
  /** openai `encoding_format`: 'float' (default) or 'base64' (packed little-endian float32). */
  encodingFormat?: 'float' | 'base64' | null;
  /** Client fields Khateway does not interpret; the openai adapter passes them through verbatim. */
  extras: Record<string, unknown>;
}
