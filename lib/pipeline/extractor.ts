/**
 * Per-letter extractor. The model reports only what one document says; it
 * never joins letters or decides which graph node is stalled.
 */

import { getLLM, hasLLMKey, LLM_MODEL, parseJsonLoose } from "../provider";
import type {
  Extraction,
  InvestigationStatus,
  InvestigationType,
} from "./types";
import { SAMPLE_LETTERS } from "./samples";

export interface ExtractInput {
  /** Use a shipped sample letter's canned extraction (demo path). */
  sampleId?: string;
  text?: string;
  imageBase64?: string;
  imageMime?: string;
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
  "confidence": number
}

Rules:
- Extract only facts written in this letter. Never infer a date; use null when it is not written.
- Keep the department and clinician department as written, without inventing ownership.
- Normalize investigation type to one of the enum values above.
- Use a short slug for each investigation id, unique within this letter.
- A finding may name the investigation it appears on and the next investigation it spawned; otherwise use null.
- A dependency is the explicit relationship in wording such as “awaiting X before Y”.
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
  const text = `${typeof value === "string" ? value : ""} ${name}`.toLowerCase();
  if (/bronch/.test(text)) return "bronchoscopy";
  if (/\bct\b|computed tomography/.test(text)) return "ct";
  if (/\bmri\b|magnetic resonance/.test(text)) return "mri";
  if (/consult|clearance|review/.test(text)) return "consult";
  if (/blood|\bigra\b|screening/.test(text)) return "bloods";
  if (/x[- ]?ray|radiograph/.test(text)) return "xray";
  return INVESTIGATION_TYPES.includes(value as InvestigationType)
    ? (value as InvestigationType)
    : "other";
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

/** Extract one letter. A marked sample runs through the live provider when a key exists. */
export async function extractLetter(input: ExtractInput): Promise<Extraction> {
  const sample = input.sampleId ? SAMPLE_LETTERS.find((item) => item.id === input.sampleId) : undefined;
  if (sample && !sample.live) return sample.extraction;

  const client = getLLM();
  if (!client || !hasLLMKey) {
    if (sample) return sample.extraction;
    if (input.text) return heuristicExtract(input.text);
    return normalize({ confidence: 0.25 });
  }

  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  const text = input.text || sample?.text;
  if (text) userContent.push({ type: "text", text });
  if (input.imageBase64) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${input.imageMime || "image/png"};base64,${input.imageBase64}` },
    });
  }
  if (userContent.length === 0) return normalize({ confidence: 0.25 });

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
    return normalize(parseJsonLoose(completion.choices[0]?.message?.content ?? "{}"));
  } catch {
    if (sample) return sample.extraction;
    if (input.text) return heuristicExtract(input.text);
    return normalize({ confidence: 0.25 });
  }
}
