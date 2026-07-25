/**
 * Deterministic coverage matching for the private escape hatch.
 *
 * No LLM is called anywhere in this file — the same stall and the same plan
 * always produce the same answer, with or without an API key configured.
 * Everything here is framed as an administrative option, never as advice.
 */

import type { Coverage, EscapeHatch, GraphNode, InvestigationType, Stall } from "./types";
import { providersFor } from "./providers";

/** Discrete, one-off steps that private cover can plausibly pick up. */
const DIAGNOSTIC_TYPES: InvestigationType[] = ["ct", "mri", "bronchoscopy", "xray", "bloods"];
const CONSULT_TYPES: InvestigationType[] = ["consult"];

/**
 * UK private medical insurance excludes chronic-disease management, so the
 * treatment approval at the end of the chain is never routed privately — only
 * a discrete diagnostic bottleneck in front of it is.
 */
const NEVER_COVERABLE_KINDS = new Set<GraphNode["kind"]>(["approval"]);

const CHRONIC_EXCLUSION_REASON =
  "This is a treatment approval, not a discrete diagnostic step. UK private medical " +
  "insurance excludes ongoing management of a chronic condition, so this step cannot be " +
  "routed privately under any plan — it has to be resolved with the NHS team that owns it.";

function matchesExclusion(node: GraphNode, excludes: string[]): string | null {
  const haystack = `${node.label} ${node.invType ?? ""} ${node.kind}`.toLowerCase();
  return (
    excludes.find((entry) => {
      const needle = entry.trim().toLowerCase();
      return needle.length > 0 && haystack.includes(needle);
    }) ?? null
  );
}

function baseCaveats(coverage: Coverage): string[] {
  const caveats = [
    "Indicative only — waits and prices are illustrative fixtures, not quotes, and not a live provider feed.",
    "Whether a step is covered depends on your individual policy wording; confirm with your insurer before booking.",
    "Going privately for this step is an administrative option to unblock the pathway, not medical advice, and not a recommendation to leave NHS care.",
    "Ask for the report to be sent back to the NHS team so the pathway continues without a duplicate test.",
  ];
  if (coverage.requires_preauth) {
    caveats.push("Your plan requires pre-authorisation — get written approval from the insurer before the appointment.");
  }
  if (coverage.requires_gp_referral) {
    caveats.push("Your plan requires a GP referral — ask your GP for an open referral for this step first.");
  }
  if (coverage.confidence < 0.6) {
    caveats.push("The plan details on file are low-confidence; check them against your policy documents.");
  }
  return caveats;
}

/**
 * Decide whether the single stalled bottleneck could be obtained privately.
 * Only `stall.stalledNode` is ever considered — no other node in the chain.
 */
export function escapeHatch(stall: Stall, coverage: Coverage): EscapeHatch | null {
  const node = stall.stalledNode;
  const planName = coverage.plan_type ? `${coverage.plan_type} ` : "";

  // The ethics rule: the treatment approval is never offered privately, and it
  // never carries a provider list, regardless of how generous the plan is.
  if (NEVER_COVERABLE_KINDS.has(node.kind)) {
    return {
      node,
      coverable: false,
      reason: CHRONIC_EXCLUSION_REASON,
      providers: [],
      caveats: [
        "Chronic-disease management is a standard exclusion on UK private medical insurance.",
        "Chasing the department that owns this approval is the route that actually moves it.",
      ],
    };
  }

  const invType = node.invType;
  const isDiagnostic = invType !== null && DIAGNOSTIC_TYPES.includes(invType);
  const isConsult = invType !== null && CONSULT_TYPES.includes(invType);

  if (invType === null || (!isDiagnostic && !isConsult)) {
    return {
      node,
      coverable: false,
      reason:
        "This step is not a discrete diagnostic test or outpatient consultation, so there is no " +
        "equivalent private appointment to book in its place.",
      providers: [],
      caveats: [],
    };
  }

  const excluded = matchesExclusion(node, coverage.excludes);
  if (excluded) {
    return {
      node,
      coverable: false,
      reason: `Your ${planName}plan lists "${excluded}" as an exclusion, which covers this step.`,
      providers: [],
      caveats: baseCaveats(coverage),
    };
  }

  const covered = isConsult ? coverage.covers_consults : coverage.covers_diagnostics;
  if (!covered) {
    return {
      node,
      coverable: false,
      reason: `Your ${planName}plan does not cover ${isConsult ? "outpatient consultations" : "diagnostic tests"}, so this step would be self-funded rather than covered.`,
      providers: [],
      caveats: baseCaveats(coverage),
    };
  }

  const providers = providersFor(invType);
  return {
    node,
    coverable: true,
    reason:
      `${node.label} is a discrete ${isConsult ? "outpatient consultation" : "diagnostic step"} that has been ` +
      `outstanding for ${stall.daysStalled} days and is holding up everything after it. Your ${planName}plan ` +
      `covers ${isConsult ? "consultations" : "diagnostics"}, so this one step could be obtained privately and ` +
      "the report returned to the NHS team. This covers the diagnostic step only — not the ongoing treatment it leads to.",
    providers,
    caveats: baseCaveats(coverage),
  };
}
