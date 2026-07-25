/**
 * Per-letter extractor. The model reports only what one document says; it
 * never joins letters or decides which graph node is stalled.
 */

import { getLLM, hasLLMKey, LLM_MODEL, parseJsonLoose } from "../provider";
import { typeFromName } from "./stateMachine";
import type {
  Extraction,
  InvestigationStatus,
  InvestigationType,
} from "./types";
import { SAMPLE_LETTERS } from "./samples";

/** One page image to send as an `image_url` content part. */
export interface LetterImage {
  base64: string;
  /** Must be a real image mime — the provider rejects application/pdf here. */
  mime: string;
}

export interface ExtractInput {
  /** Use a shipped sample letter's canned extraction (demo path). */
  sampleId?: string;
  text?: string;
  /** One entry per page for a rasterized PDF; a single entry for an image upload. */
  images?: LetterImage[];
  /** Optional note appended to the prompt, e.g. that only the first N pages were sent. */
  imagesNote?: string;
}

/**
 * A failure the caller must surface, not paper over. Extraction returning an
 * empty result on a provider 400 is what made a broken upload look like a
 * one-node pathway with nothing overdue (GLD-11).
 */
export class ExtractionError extends Error {
  constructor(
    message: string,
    /** HTTP status /api/extract should answer with. */
    readonly status = 502,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExtractionError";
  }
}

/** Only real raster images may ride in an image_url part. */
function isSupportedImageMime(mime: string): boolean {
  return /^image\/(png|jpeg|jpg|webp|gif)$/i.test(mime.trim());
}

/** Best-effort readable message out of an OpenAI-SDK / Runware error. */
function providerMessage(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as { status?: number; message?: string; error?: { message?: string } };
  const detail = e.error?.message || e.message || "unknown provider error";
  return e.status ? `${e.status} ${detail}` : detail;
}

const INVESTIGATION_TYPES: InvestigationType[] = [
  "ct",
  "mri",
  "bronchoscopy",
  "consult",
  "bloods",
  "xray",
  "other",
];
const INVESTIGATION_STATUSES: InvestigationStatus[] = [
  "ordered",
  "booked",
  "done",
  "reported",
  "actioned",
  "unknown",
];

const SYSTEM_PROMPT = `You extract structured data from ONE UK NHS letter for a cross-department care pathway.

Return STRICT JSON only — no prose and no markdown fences. Use exactly this schema:
{
  "letter_date": "YYYY-MM-DD" | null,
  "department": string | null,
  "clinicians": [{"name": string, "dept": string | null}],
  "investigations": [{
    "id": string, "name": string,
    "type": "ct" | "mri" | "bronchoscopy" | "consult" | "bloods" | "xray" | "other",
    "ordered_date": "YYYY-MM-DD" | null,
    "report_date": "YYYY-MM-DD" | null,
    "status": "ordered" | "booked" | "done" | "reported" | "actioned" | "unknown"
  }],
  "findings": [{"text": string, "on_investigation": string | null, "spawned": string | null}],
  "referrals": [{"from_dept": string | null, "to_dept": string | null, "reason": string | null, "date": "YYYY-MM-DD" | null}],
  "dependencies": [{"blocked_item": string, "blocking_item": string, "stated_status": string | null}],
  "mdt": [{"date": "YYYY-MM-DD" | null, "outcome": string | null, "awaiting": string | null}],
  "stated_goal": string | null,
  "follow_ups": [{"item": string, "phrase": string | null, "from": string | null, "due_date": "YYYY-MM-DD" | null}],
  "confidence": number
}

Rules:
- Extract only facts written in this letter. Never infer a date; use null when it is not written.
- ordered_date is when the step was REQUESTED; report_date is when it was CARRIED OUT or resulted. An investigation this letter describes in the past tense with a date ("chest X-ray on 13/03/2026 showed...", "bronchoscopy performed 20-May") is a completed step: put that date in report_date, leave ordered_date null unless the request date is also written, and set status to done or reported. This applies whether or not the letter is the one that ordered it — a later letter reporting an earlier test still dates that test.
- Dates appear in many forms — "12th January 2026", "06-FEB-2026", "20/02/26", "2nd March 2026", "13th March" — always emit YYYY-MM-DD. A UK date is day-first: 06/02/2026 is 6 February. A two-digit year in this context is 20YY.
- Keep the department and clinician department as written, without inventing ownership.
- Normalize investigation type to one of the enum values above.
- Use a short slug for each investigation id, unique within this letter.
- A finding may name the investigation it appears on and the next investigation it spawned; otherwise use null.
- A dependency is the explicit relationship in wording such as “awaiting X before Y”.
- stated_goal: the treatment or decision THIS letter says the pathway is working toward, in the letter's own words and as a short phrase — for example "Start filgotinib", "Approve infliximab funding". Use null when this letter states no such intent. NAME it only: never say whether it has happened, how far along it is, or what is delaying it.
- follow_ups: every wait this letter promises in WORDS rather than as a booked date — "FU 4 weeks", "review in about 6 weeks time", "culture negative at six weeks", "carried out next week", "repeat CT at the 3-month point". Copy the interval into "phrase" exactly as written; put what is due in "item"; put the event it counts from in "from" using the letter's own words ("bronchoscopy"), or null when it counts from this letter. Use "due_date" only when the letter writes an actual calendar date it is due by. Do not compute a due date yourself and do not invent a follow-up the letter does not promise.
- Do not diagnose, interpret, prioritize, or decide urgency. Lower confidence rather than guessing.`;

function isISODate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function normalizeType(value: unknown, name = ""): InvestigationType {
  // The model is instructed to emit the normalized enum. Trust a recognized
  // explicit value; inferring from the name can create false positives (for
  // example, "TB-screening chest X-ray" contains "screening").
  if (INVESTIGATION_TYPES.includes(value as InvestigationType) && value !== "other") {
    return value as InvestigationType;
  }

  // Only recover from an omitted, invalid, or generic "other" type.
  return typeFromName(name);
}

function normalize(raw: unknown): Extraction {
  const o = (raw ?? {}) as Record<string, unknown>;
  const rawInvestigations = Array.isArray(o.investigations) ? o.investigations : [];
  const investigations = rawInvestigations.map((item, index) => {
    const value = (item ?? {}) as Record<string, unknown>;
    const name = nullableString(value.name) ?? `Investigation ${index + 1}`;
    const id = slug(nullableString(value.id) ?? name);
    const status = INVESTIGATION_STATUSES.includes(value.status as InvestigationStatus)
      ? (value.status as InvestigationStatus)
      : "unknown";
    return {
      id: `${id}-${index + 1}`,
      name,
      type: normalizeType(value.type, name),
      ordered_date: isISODate(value.ordered_date) ? value.ordered_date : null,
      report_date: isISODate(value.report_date) ? value.report_date : null,
      status,
    };
  });

  const clinicians = (Array.isArray(o.clinicians) ? o.clinicians : []).flatMap((item) => {
    const value = (item ?? {}) as Record<string, unknown>;
    const name = nullableString(value.name);
    return name ? [{ name, dept: nullableString(value.dept) }] : [];
  });
  const findings = (Array.isArray(o.findings) ? o.findings : []).flatMap((item) => {
    const value = (item ?? {}) as Record<string, unknown>;
    const text = nullableString(value.text);
    return text
      ? [{
          text,
          on_investigation: nullableString(value.on_investigation),
          spawned: nullableString(value.spawned),
        }]
      : [];
  });
  const referrals = (Array.isArray(o.referrals) ? o.referrals : []).map((item) => {
    const value = (item ?? {}) as Record<string, unknown>;
    return {
      from_dept: nullableString(value.from_dept),
      to_dept: nullableString(value.to_dept),
      reason: nullableString(value.reason),
      date: isISODate(value.date) ? value.date : null,
    };
  });
  const dependencies = (Array.isArray(o.dependencies) ? o.dependencies : []).flatMap((item) => {
    const value = (item ?? {}) as Record<string, unknown>;
    const blocked = nullableString(value.blocked_item);
    const blocking = nullableString(value.blocking_item);
    return blocked && blocking
      ? [{ blocked_item: blocked, blocking_item: blocking, stated_status: nullableString(value.stated_status) }]
      : [];
  });
  const mdt = (Array.isArray(o.mdt) ? o.mdt : []).map((item) => {
    const value = (item ?? {}) as Record<string, unknown>;
    return {
      date: isISODate(value.date) ? value.date : null,
      outcome: nullableString(value.outcome),
      awaiting: nullableString(value.awaiting),
    };
  });
  const followUps = (Array.isArray(o.follow_ups) ? o.follow_ups : []).flatMap((item) => {
    const value = (item ?? {}) as Record<string, unknown>;
    const name = nullableString(value.item);
    const phrase = nullableString(value.phrase);
    const dueDate = isISODate(value.due_date) ? value.due_date : null;
    // A follow-up with neither an interval nor a date promises nothing timeable.
    return name && (phrase || dueDate)
      ? [{ item: name, phrase, from: nullableString(value.from), due_date: dueDate }]
      : [];
  });
  const confidence = typeof o.confidence === "number" ? o.confidence : 0.35;

  return {
    letter_date: isISODate(o.letter_date) ? o.letter_date : null,
    department: nullableString(o.department),
    clinicians,
    investigations,
    findings,
    referrals,
    dependencies,
    mdt,
    stated_goal: nullableString(o.stated_goal),
    follow_ups: followUps,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

/** Conservative offline fallback for arbitrary text. */
function heuristicExtract(text: string): Extraction {
  const lower = text.toLowerCase();
  const date = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)?.[0] ?? null;
  const department = /respiratory|pulmon/.test(lower)
    ? "Respiratory"
    : /gastro|ibd|biologic|jak inhibitor/.test(lower)
      ? "Gastroenterology"
      : null;
  const investigations: Extraction["investigations"] = [];
  const add = (name: string, type: InvestigationType, status: Extraction["investigations"][number]["status"]) => {
    if (!investigations.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      investigations.push({ id: slug(name), name, type, ordered_date: date, report_date: null, status });
    }
  };
  if (/x[- ]?ray|radiograph/.test(lower)) add("Chest X-ray", "xray", /report|result|finding/.test(lower) ? "reported" : "ordered");
  if (/\bct\b|computed tomography/.test(lower)) add("CT chest", "ct", /report|result/.test(lower) ? "reported" : "ordered");
  if (/bronchosc/.test(lower)) add("Bronchoscopy", "bronchoscopy", /report|result/.test(lower) ? "reported" : "ordered");
  if (/blood|\bigra\b/.test(lower)) add("Screening bloods", "bloods", /complete|result/.test(lower) ? "done" : "ordered");
  if (/consult|clearance/.test(lower)) add("Respiratory clearance", "consult", /completed|clear/.test(lower) ? "actioned" : "ordered");
  return normalize({
    letter_date: date,
    department,
    investigations,
    findings: [],
    referrals: [],
    dependencies: [],
    mdt: [],
    confidence: 0.45,
  });
}

/**
 * Extract one letter. A marked sample runs through the live provider when a key exists.
 *
 * Fallbacks apply only where they are genuinely a fallback — no key configured,
 * so the demo still runs offline. A provider failure is never masked: it throws
 * an ExtractionError so /api/extract answers non-200 and the UI can say what
 * went wrong, instead of returning an empty extraction at 200.
 */
export async function extractLetter(input: ExtractInput): Promise<Extraction> {
  const sample = input.sampleId ? SAMPLE_LETTERS.find((item) => item.id === input.sampleId) : undefined;
  if (sample && !sample.live) return sample.extraction;

  const images = input.images ?? [];
  const badImage = images.find((image) => !isSupportedImageMime(image.mime));
  if (badImage) {
    // Guards the exact GLD-11 regression: a PDF must be rasterized first, never
    // handed to the provider as a data:application/pdf image_url part.
    throw new ExtractionError(
      `Unsupported image type "${badImage.mime}" — pages must be rasterized to an image before extraction.`,
      400,
    );
  }

  const client = getLLM();
  if (!client || !hasLLMKey) {
    if (sample) return sample.extraction;
    if (input.text) return heuristicExtract(input.text);
    // Nothing to work with offline: a page image needs the vision model. Say so
    // rather than returning an empty extraction that looks like a real result.
    throw new ExtractionError(
      images.length
        ? "This letter has no extractable text, so it needs the vision model — but no LLM key is configured."
        : "Nothing to extract: provide letter text, a PDF, or an image.",
      images.length ? 503 : 400,
    );
  }

  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  const text = input.text || sample?.text;
  if (text) userContent.push({ type: "text", text });
  if (input.imagesNote) userContent.push({ type: "text", text: input.imagesNote });
  for (const image of images) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${image.mime};base64,${image.base64}` },
    });
  }
  if (userContent.length === 0) {
    throw new ExtractionError("Nothing to extract: provide letter text, a PDF, or an image.", 400);
  }

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });
  } catch (err) {
    throw new ExtractionError(
      `The model could not read this letter (${providerMessage(err)}).`,
      502,
      { cause: err },
    );
  }

  const raw = completion.choices[0]?.message?.content ?? "";
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length === 0) {
    throw new ExtractionError("The model returned no usable JSON for this letter.", 502);
  }
  return normalize(parsed);
}
