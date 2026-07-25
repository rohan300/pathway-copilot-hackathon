/**
 * Agent 4 — Drafter (LLM). Turns the deterministic stall output plus
 * vitals deltas into ready-to-send text for a chosen target.
 *
 * Voice: polite, specific, factual, firm. Cites exact dates and day counts.
 * Names ONE requested action and ONE requested date. Never angry or pleading.
 * NEVER makes a clinical claim — vitals are objective context only. Escalations
 * are administrative (chasing a process), not medical.
 *
 * Without a RUNWARE_API_KEY, a deterministic template produces equivalent text.
 */

import { getLLM, hasLLMKey, LLM_MODEL, parseJsonLoose } from "../provider";
import type { DraftInput, DraftResult, DraftTarget, VitalsResult } from "./types";

const TARGET_LABEL: Record<DraftTarget, string> = {
  advice_line: "IBD advice line",
  pals: "PALS (Patient Advice and Liaison Service)",
  clinician_summary: "clinician summary",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function requestedDateISO(daysAhead = 7): string {
  return new Date(Date.now() + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

/** Human vitals context line — objective deltas only, never a clinical claim. */
function vitalsContext(vitals: VitalsResult | null): string | null {
  if (!vitals) return null;
  const hr = vitals.deltas.resting_hr;
  const hrv = vitals.deltas.hrv;
  const parts: string[] = [];
  if (hr && hr.absolute !== 0) {
    parts.push(
      `resting heart rate ${hr.absolute > 0 ? "up" : "down"} ${Math.abs(hr.absolute)} bpm`,
    );
  }
  if (hrv && hrv.absolute !== 0) {
    parts.push(`HRV ${hrv.absolute > 0 ? "up" : "down"} ${Math.abs(hrv.absolute)} ms`);
  }
  if (parts.length === 0) return null;
  return `For objective context only, my own wearable data over this period shows ${parts.join(
    " and ",
  )} versus my baseline. I share this as context, not as a medical claim.`;
}

/** Shared factual bullets — the ground truth both the LLM and mock draft from. */
function factsBlock(input: DraftInput): string {
  const { stall, vitals, meta } = input;
  const since = stall.sinceDate || "not written";
  const chain = stall.chain.map((node) => node.label).join(" -> ");
  const lines = [
    `Stalled node: ${stall.stalledNode.label}`,
    `Owning department: ${stall.owningDept || "not identified"}`,
    `Stalled since: ${since}`,
    `Days stalled: ${stall.daysStalled}`,
    `Expected window for this node: ${stall.expectedDays === null ? "not defined" : `${stall.expectedDays} days`}`,
    `Downstream dependency chain: ${chain}`,
  ];
  if (meta?.patient_name) lines.push(`Patient name: ${meta.patient_name}`);
  if (meta?.hospital) lines.push(`Hospital: ${meta.hospital}`);
  if (meta?.nhs_number) lines.push(`NHS number: ${meta.nhs_number}`);
  const vc = vitalsContext(vitals);
  if (vc) lines.push(`Wearable context (objective, non-clinical): ${vc}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic mock drafts (no key)
// ---------------------------------------------------------------------------

function mockMessage(input: DraftInput, target: Exclude<DraftTarget, "clinician_summary">): string {
  const { stall, meta } = input;
  const name = meta?.patient_name || "[Your name]";
  const nhs = meta?.nhs_number ? ` (NHS number ${meta.nhs_number})` : "";
  const by = requestedDateISO();
  const vc = vitalsContext(input.vitals);
  const dateLine = stall.sinceDate
    ? `It has been ${stall.daysStalled} days since ${stall.stalledNode.label} was recorded on ${stall.sinceDate}.`
    : `${stall.stalledNode.label} is overdue, although its start date was not written in the letters.`;

  const opener =
    target === "pals"
      ? `Dear PALS team,`
      : `Dear IBD advice line,`;

  return [
    opener,
    ``,
    `I am writing to ask for help moving my IBD pathway forward. My name is ${name}${nhs}.`,
    ``,
    `${dateLine} The expected window for this step is ${stall.expectedDays ?? "an unspecified"} days.`,
    ``,
    `The outstanding item is ${stall.stalledNode.label}, owned by ${stall.owningDept || "the relevant department"}. It is holding up ${stall.chain[stall.chain.length - 1]?.label || "the next pathway step"}.`,
    vc ? `` : ``,
    vc ?? ``,
    ``,
    `Could you please confirm the current status of this step and provide an expected date for it to be completed? I would be grateful for a response by ${by}.`,
    ``,
    `Thank you for your help.`,
    ``,
    `Kind regards,`,
    name,
  ]
    .filter((l) => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function mockClinicianSummary(input: DraftInput): { text: string; questions: string[] } {
  const { stall } = input;
  const vc = vitalsContext(input.vitals);
  const text = [
    `PATHWAY SUMMARY — Critical Path`,
    ``,
    `• Stalled node: ${stall.stalledNode.label}`,
    `• Owning department: ${stall.owningDept || "Not identified"}`,
    `• Stalled since: ${stall.sinceDate || "Date not written"}`,
    `• Days stalled: ${stall.daysStalled}${stall.expectedDays !== null ? ` (expected window ${stall.expectedDays} days)` : ""}`,
    `• Downstream chain: ${stall.chain.map((node) => node.label).join(" → ")}`,
    vc ? `• Wearable context (objective, non-clinical): ${vc}` : ``,
    ``,
    `This summary is administrative and reconstructed from the patient's own`,
    `letters. It contains no clinical assessment.`,
  ]
    .filter(Boolean)
    .join("\n");

  const questions = [
    `What is the current status of ${stall.stalledNode.label}?`,
    `Which department owns this outstanding item?`,
    `What date is recorded for the next administrative update?`,
    `Who should I contact if I do not hear back by that date?`,
  ];
  return { text, questions };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You draft administrative escalation messages for a UK NHS IBD patient who is chasing progress on their biologics pathway.

Voice: polite, specific, factual, and firm. Never angry, never pleading.
- Cite exact dates and day counts from the facts provided.
- Name exactly ONE requested action and ONE requested date.
- These are ADMINISTRATIVE escalations (chasing a process), NOT medical requests.
- NEVER make a clinical claim. Wearable/vitals figures are objective context only, not evidence of disease activity.
- Do not invent facts beyond those provided.`;

export async function draft(input: DraftInput): Promise<DraftResult> {
  const client = getLLM();
  const facts = factsBlock(input);

  // Mock mode: no key.
  if (!client || !hasLLMKey) {
    if (input.target === "clinician_summary") {
      const { text, questions } = mockClinicianSummary(input);
      return { target: input.target, text, questions, mocked: true };
    }
    return {
      target: input.target,
      text: mockMessage(input, input.target),
      mocked: true,
    };
  }

  // LLM mode. Any provider/network error degrades to the deterministic template
  // so the app never fails to produce a draft.
  if (input.target === "clinician_summary") {
    const fallback = mockClinicianSummary(input);
    try {
      const completion = await client.chat.completions.create({
        model: LLM_MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `${SYSTEM_PROMPT}\n\nReturn STRICT JSON: { "text": string (a structured one-pager summary), "questions": string[] (a short list of questions the patient should ask) }.`,
          },
          { role: "user", content: `Facts:\n${facts}` },
        ],
      });
      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = parseJsonLoose(raw) as { text?: string; questions?: string[] };
      return {
        target: input.target,
        text: typeof parsed.text === "string" ? parsed.text : fallback.text,
        questions: Array.isArray(parsed.questions) ? parsed.questions : fallback.questions,
        mocked: false,
      };
    } catch {
      return { target: input.target, text: fallback.text, questions: fallback.questions, mocked: false };
    }
  }

  try {
    const completion = await client.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Target: ${TARGET_LABEL[input.target]}\n\nFacts:\n${facts}\n\nWrite the message, ready to send.`,
        },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim() || mockMessage(input, input.target);
    return { target: input.target, text, mocked: false };
  } catch {
    return { target: input.target, text: mockMessage(input, input.target), mocked: false };
  }
}
