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
import type { DraftInput, DraftResult, DraftTarget, EscapeHatch, VitalsResult } from "./types";

const TARGET_LABEL: Record<DraftTarget, string> = {
  advice_line: "IBD advice line",
  pals: "PALS (Patient Advice and Liaison Service)",
  clinician_summary: "clinician summary",
  insurer_preauth: "private medical insurer (pre-authorisation request)",
  nhs_private_notice: "NHS team (notice that one step is being obtained privately)",
};

/** Message targets — everything except the structured clinician one-pager. */
type MessageTarget = Exclude<DraftTarget, "clinician_summary">;
type PrivateTarget = "insurer_preauth" | "nhs_private_notice";

function isPrivateTarget(target: DraftTarget): target is PrivateTarget {
  return target === "insurer_preauth" || target === "nhs_private_notice";
}

/**
 * The private-route targets describe an administrative option, never a clinical
 * one. Drafting is refused outright unless the deterministic coverage matcher
 * marked this exact step coverable — which is what stops a private-route letter
 * ever being written for the chronic-treatment approval.
 */
function requireCoverableHatch(input: DraftInput): EscapeHatch {
  const hatch = input.escapeHatch;
  if (!hatch) {
    throw new Error(`target ${input.target} requires escapeHatch`);
  }
  if (!hatch.coverable) {
    throw new Error(
      `target ${input.target} requires a coverable escapeHatch; this step cannot be routed privately`,
    );
  }
  return hatch;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function requestedDateISO(daysAhead = 7): string {
  return new Date(Date.now() + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

/** Soonest-wait provider on the hatch, if the fixture offered any. */
function leadProvider(hatch: EscapeHatch) {
  return hatch.providers[0] ?? null;
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

  // Escape-hatch facts are additive — the Stall-based escalation drafts are
  // unchanged because no hatch is ever supplied for those targets.
  const hatch = input.escapeHatch;
  if (hatch && hatch.coverable) {
    lines.push(`Step being obtained privately: ${hatch.node.label}`);
    lines.push(`Investigation type: ${hatch.node.invType ?? "not specified"}`);
    lines.push(`Coverage note (administrative, deterministic): ${hatch.reason}`);
    const provider = leadProvider(hatch);
    if (provider) {
      lines.push(
        `Indicative private provider (illustrative fixture, not a quote): ${provider.name}, ` +
          `${provider.region}, indicative wait ${provider.indicative_wait_days} days, ` +
          `indicative price £${provider.indicative_price_gbp}`,
      );
    }
    if (hatch.caveats.length > 0) {
      lines.push(`Caveats that must not be contradicted: ${hatch.caveats.join(" ")}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic mock drafts (no key)
// ---------------------------------------------------------------------------

/**
 * Private-route templates. Both are administrative: they ask for a decision or
 * give a notice, and neither says or implies that going private is the better
 * clinical choice. The NHS route is named as the one that continues in parallel.
 */
function mockPrivateMessage(
  input: DraftInput,
  target: PrivateTarget,
  hatch: EscapeHatch,
): string {
  const { stall, meta } = input;
  const name = meta?.patient_name || "[Your name]";
  const nhs = meta?.nhs_number ? ` (NHS number ${meta.nhs_number})` : "";
  const hospital = meta?.hospital || "my NHS hospital";
  const by = requestedDateISO();
  const step = hatch.node.label;
  const provider = leadProvider(hatch);
  const waitLine = stall.sinceDate
    ? `It has been ${stall.daysStalled} days since ${step} was recorded on ${stall.sinceDate}, against an expected window of ${stall.expectedDays ?? "an unspecified number of"} days.`
    : `${step} has been outstanding for ${stall.daysStalled} days; its start date was not written in the letters I hold.`;

  if (target === "insurer_preauth") {
    return [
      `Dear Sir or Madam,`,
      ``,
      `I am writing to request written pre-authorisation for a single outpatient item under my policy. My name is ${name}${nhs}.`,
      ``,
      `The item is ${step}${hatch.node.invType ? ` (${hatch.node.invType})` : ""}, currently outstanding on my NHS pathway at ${hospital}. ${waitLine} My NHS referral remains open and I am not withdrawing from NHS care; I am asking to obtain this one diagnostic step privately so that the report can be returned to the NHS team.`,
      ...(provider
        ? [
            ``,
            `The provider I intend to use is ${provider.name} (${provider.region}). Their indicative wait is ${provider.indicative_wait_days} days and the indicative cost is £${provider.indicative_price_gbp}; I understand these figures are illustrative and not a quotation.`,
          ]
        : []),
      ``,
      `This request covers the diagnostic step only, and not the ongoing management of my condition.`,
      ``,
      `Could you please confirm in writing whether this single item is authorised under my policy? I would be grateful for a written response by ${by}.`,
      ``,
      `Thank you for your help.`,
      ``,
      `Kind regards,`,
      name,
    ]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  return [
    `Dear ${stall.owningDept || "team"},`,
    ``,
    `I am writing to let you know, as a courtesy, that I intend to obtain one outstanding step on my pathway privately. My name is ${name}${nhs}.`,
    ``,
    `${waitLine} The step is ${step}, and it is holding up ${stall.chain[stall.chain.length - 1]?.label || "the next step on my pathway"}.`,
    ...(provider
      ? [
          ``,
          `I intend to have it done at ${provider.name} (${provider.region}), where the indicative wait is ${provider.indicative_wait_days} days.`,
        ]
      : []),
    ``,
    `I would like to stay under your care and keep my NHS referral open. I will arrange for the report to be sent directly to you so that the pathway can continue without a duplicate test.`,
    ``,
    `Could you please confirm that you are able to accept the private report into my NHS record? I would be grateful for a response by ${by}.`,
    ``,
    `Thank you for your help.`,
    ``,
    `Kind regards,`,
    name,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function mockMessage(input: DraftInput, target: MessageTarget): string {
  if (isPrivateTarget(target)) {
    return mockPrivateMessage(input, target, requireCoverableHatch(input));
  }
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

/**
 * Appended for the private-route targets only. The hard rule is the last one:
 * the private route is an administrative way to unblock one step, and the draft
 * must never present it as the medically better choice.
 */
const PRIVATE_PROMPT = `
This message concerns obtaining ONE outstanding step privately while the NHS pathway continues.
- The patient is NOT leaving NHS care and their NHS referral stays open — say so.
- Ask for the report to be returned to the NHS team so no duplicate test is needed.
- Cover the single diagnostic step only, never ongoing treatment or chronic management.
- Waits and prices given are indicative illustrative figures, not quotations — never present them as quotes.
- NEVER state or imply that going privately is medically advisable, safer, or clinically better. It is an administrative option to unblock a stalled step, nothing more.
- Do not contradict any caveat listed in the facts.`;

export async function draft(input: DraftInput): Promise<DraftResult> {
  // Refuse before any work: a private-route draft for a step the deterministic
  // matcher did not mark coverable must never be produced, key or no key.
  if (isPrivateTarget(input.target)) requireCoverableHatch(input);

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
        {
          role: "system",
          content: isPrivateTarget(input.target)
            ? `${SYSTEM_PROMPT}\n${PRIVATE_PROMPT}`
            : SYSTEM_PROMPT,
        },
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
