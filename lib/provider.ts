import OpenAI from "openai";

/**
 * LLM provider layer.
 *
 * Runware is our LLM provider and exposes a drop-in OpenAI-compatible endpoint,
 * so we drive it through the `openai` SDK with a custom baseURL — no bespoke
 * HTTP client needed. Both AI touchpoints (the Extractor and the Drafter) go
 * through this module.
 *
 * If RUNWARE_API_KEY is set, real calls are made. If it is missing, the app
 * still runs end-to-end: callers fall back to deterministic mocks so the demo
 * works with no key. The key is stored in secrets, never in code.
 *
 * HARD CONSTRAINT (see README): the LLM only extracts JSON from documents and
 * drafts prose. It NEVER decides clinical stage or urgency — that lives in the
 * deterministic state machine (lib/pipeline/stateMachine.ts).
 */

/** Runware's OpenAI-compatible base URL. Override with RUNWARE_BASE_URL. */
const BASE_URL =
  process.env.RUNWARE_BASE_URL?.trim() || "https://api.runware.ai/v1";

// Prefer RUNWARE_API_KEY; fall back to a legacy OPENAI_API_KEY so an existing
// local .env keeps working during the provider swap.
const apiKey =
  process.env.RUNWARE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();

/** True when a real key is configured; false means deterministic mock mode. */
export const hasLLMKey: boolean = Boolean(apiKey);

/**
 * The model used for extraction and drafting. Override with RUNWARE_MODEL.
 *
 * Default: GPT-5-4 Mini via Runware — cheap, fast, and JSON-friendly. Runware's
 * OpenAI-compatible endpoint uses fully-hyphenated `provider-model-version` ids
 * (e.g. `openai-gpt-5-4-mini`) — NOT the `provider:model@variant` form. List the
 * exact accepted ids with `GET /v1/models`.
 *
 * NOTE: Gemini models are NOT compatible with our `response_format:
 * {type:'json_object'}` on Runware — they 400 with "Missing required parameter:
 * jsonSchema". GPT-5 mini accepts json_object + temperature and returns valid
 * JSON at 200, and is cheaper. Also: gpt-5 models reject `max_tokens` (they want
 * `max_completion_tokens`) — our code sends neither, so don't add `max_tokens`.
 */
export const LLM_MODEL: string =
  process.env.RUNWARE_MODEL?.trim() ||
  process.env.OPENAI_MODEL?.trim() ||
  "openai-gpt-5-4-mini";

let client: OpenAI | null = null;

/**
 * Returns a configured LLM client (pointed at Runware), or null when no key is
 * present. Callers MUST handle null by returning a deterministic mock so the app
 * runs without a key.
 */
export function getLLM(): OpenAI | null {
  if (!apiKey) return null;
  if (!client) client = new OpenAI({ apiKey, baseURL: BASE_URL });
  return client;
}

/**
 * Parse JSON from a model response, tolerating markdown fences or stray prose
 * that some models emit despite a JSON instruction. Returns `{}` if nothing
 * parseable is found, so callers can normalize to a safe default.
 */
export function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to fence / brace extraction */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return {};
}
