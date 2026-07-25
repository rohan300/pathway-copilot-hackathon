/**
 * Agent 4 — Drafter (LLM). Turns the deterministic state-machine output plus
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
  const { state, vitals, meta } = input;
  const lines = [
    `Current pathway stage: ${state.current_stage.replace("_", " ")}`,
    `Days in current stage: ${state.days_in_stage}`,
    `Total days since referral: ${state.total_days_elapsed}`,
    `Overdue: ${state.overdue ? "yes" : "no"}`,
    `Outstanding step (blocker): ${state.blocker}`,
    `Benchmark: ${state.benchmark_comparison}`,
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
  const { state, meta } = input;
  const name = meta?.patient_name || "[Your name]";
  const nhs = meta?.nhs_number ? ` (NHS number ${meta.nhs_number})` : "";
  const by = requestedDateISO();
  const stage = state.current_stage.replace("_", " ");
  const vc = vitalsContext(input.vitals);

  const overdueLine = state.overdue
    ? `I have now been at the ${stage} stage for ${state.days_in_stage} days, which is beyond the expected timeframe for this step.`
    : `I have been at the ${stage} stage for ${state.days_in_stage} days.`;

  const opener =
    target === "pals"
      ? `Dear PALS team,`
      : `Dear IBD advice line,`;

  return [
    opener,
    ``,
    `I am writing to ask for help moving my IBD biologics pathway forward. My name is ${name}${nhs}.`,
    ``,
    `${overdueLine} In total it has been ${state.total_days_elapsed} days since my referral. ${state.benchmark_comparison}`,
    ``,
    `The outstanding step is: ${state.blocker}.`,
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
  const { state } = input;
  const stage = state.current_stage.replace("_", " ");
  const vc = vitalsContext(input.vitals);
  const text = [
    `PATHWAY SUMMARY — IBD biologics`,
    ``,
    `• Current stage: ${stage}`,
    `• Days in current stage: ${state.days_in_stage}${state.overdue ? " (beyond expected timeframe)" : ""}`,
    `• Total days since referral: ${state.total_days_elapsed}`,
    `• Benchmark: ${state.benchmark_comparison}`,
    `• Outstanding step: ${state.blocker}`,
    vc ? `• Wearable context (objective, non-clinical): ${vc}` : ``,
    ``,
    `This summary is administrative and reconstructed from the patient's own`,
    `letters. It contains no clinical assessment.`,
  ]
    .filter(Boolean)
    .join("\n");

  const questions = [
    `What is the current status of: ${state.blocker}?`,
    `What is the expected date for the next step to be completed?`,
    `Is there anything I can do to help avoid further delay?`,
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
