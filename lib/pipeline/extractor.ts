/**
 * Agent 1 — Extractor (LLM). Turns one NHS letter (text or image) into strict
 * JSON. The LLM ONLY reads what the document says: absent fields are null,
 * dates are never inferred, low confidence is flagged rather than guessed.
 *
 * Without a RUNWARE_API_KEY, a deterministic mock returns coherent output so
 * the whole app runs keyless.
 */

import { getLLM, hasLLMKey, LLM_MODEL, parseJsonLoose } from "../provider";
import type { DocType, Extraction, StageSignal } from "./types";
import { SAMPLE_LETTERS } from "./samples";

export interface ExtractInput {
  /** Use a shipped sample letter's canned extraction (demo path). */
  sampleId?: string;
  /** Raw letter text. */
  text?: string;
  /** Base64-encoded image of a letter (used with a real key, vision model). */
  imageBase64?: string;
  imageMime?: string;
}

const DOC_TYPES: DocType[] = [
  "referral",
  "clinic_letter",
  "test_result",
  "funding",
  "homecare",
  "other",
];
const STAGE_SIGNALS: StageSignal[] = [
  "referral",
  "screening",
  "funding",
  "homecare",
  "dosing",
  "unknown",
];

const SYSTEM_PROMPT = `You extract structured data from a single UK NHS letter about an IBD (inflammatory bowel disease) biologics pathway.

Return STRICT JSON only — no prose, no markdown fences. Use exactly this schema:
{
  "date": "YYYY-MM-DD" | null,
  "doc_type": "referral" | "clinic_letter" | "test_result" | "funding" | "homecare" | "other",
  "stage_signal": "referral" | "screening" | "funding" | "homecare" | "dosing" | "unknown",
  "clinician": string | null,
  "actions_stated": string[],
  "tests_ordered": string[],
  "drugs_mentioned": string[],
  "confidence": number   // 0.0 to 1.0
}

Rules:
- If a field is absent from the document, use null (or [] for lists). Do not invent values.
- NEVER infer a date that is not written in the document. If no date is written, use null.
- Do not diagnose or decide clinical urgency. Only report what the letter states.
- If the document is unclear, lower "confidence" rather than guessing.`;

/** Coerce arbitrary model/heuristic output into a valid Extraction. */
function normalize(raw: unknown): Extraction {
  const o = (raw ?? {}) as Record<string, unknown>;
  const asStrArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const date =
    typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null;
  const doc_type = DOC_TYPES.includes(o.doc_type as DocType)
    ? (o.doc_type as DocType)
    : "other";
  const stage_signal = STAGE_SIGNALS.includes(o.stage_signal as StageSignal)
    ? (o.stage_signal as StageSignal)
    : "unknown";
  let confidence = typeof o.confidence === "number" ? o.confidence : 0.5;
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    date,
    doc_type,
    stage_signal,
    clinician: typeof o.clinician === "string" ? o.clinician : null,
    actions_stated: asStrArray(o.actions_stated),
    tests_ordered: asStrArray(o.tests_ordered),
    drugs_mentioned: asStrArray(o.drugs_mentioned),
    confidence,
  };
}

/** Lightweight deterministic extraction for arbitrary text in mock mode. */
function heuristicExtract(text: string): Extraction {
  const lower = text.toLowerCase();
  const dateMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const pick = <T extends string>(map: [RegExp, T][], fallback: T): T => {
    for (const [re, val] of map) if (re.test(lower)) return val;
    return fallback;
  };
  const stage_signal = pick<StageSignal>(
    [
      [/homecare|home care|home delivery/, "homecare"],
      [/first dose|dosing|infusion booked|administered/, "dosing"],
      [/funding|blueteq|ifr|panel|prior approval/, "funding"],
      [/screening|igra|tb screen|pre-biologic|bloods/, "screening"],
      [/referr/, "referral"],
    ],
    "unknown",
  );
  const doc_type = pick<DocType>(
    [
      [/referr/, "referral"],
      [/funding|blueteq/, "funding"],
      [/homecare|home delivery/, "homecare"],
      [/result|igra|x-ray|blood test/, "test_result"],
      [/clinic|reviewed|consultant/, "clinic_letter"],
    ],
    "other",
  );
  return normalize({
    date: dateMatch ? dateMatch[0] : null,
    doc_type,
    stage_signal,
    confidence: 0.55,
  });
}

/** Extract a single letter into strict JSON. Uses the LLM if a key is set. */
export async function extractLetter(input: ExtractInput): Promise<Extraction> {
  // Sample letters always resolve to their canned extraction (demo path).
  if (input.sampleId) {
    const sample = SAMPLE_LETTERS.find((s) => s.id === input.sampleId);
    if (sample) return sample.extraction;
  }

  const client = getLLM();

  // Mock mode: no key.
  if (!client || !hasLLMKey) {
    if (input.text) return heuristicExtract(input.text);
    return normalize({ confidence: 0.3 });
  }

  // LLM mode.
  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  if (input.text) {
    userContent.push({ type: "text", text: input.text });
  }
  if (input.imageBase64) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:${input.imageMime || "image/png"};base64,${input.imageBase64}`,
      },
    });
  }
  if (userContent.length === 0) return normalize({ confidence: 0.3 });

  // Any provider/network error degrades to a safe low-confidence extraction (or
  // the text heuristic) rather than failing the request — the demo never breaks.
  try {
    const completion = await client.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });

    const content = completion.choices[0]?.message?.content ?? "{}";
    return normalize(parseJsonLoose(content));
  } catch {
    if (input.text) return heuristicExtract(input.text);
    return normalize({ confidence: 0.3 });
  }
}
