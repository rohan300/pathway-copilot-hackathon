/**
 * The private-route drafter has to hold two lines with no API key present:
 * it must produce a usable template, and it must refuse outright for any step
 * the deterministic coverage matcher did not mark coverable.
 */

import { describe, expect, it } from "vitest";
import { escapeHatch } from "./coverage";
import { draft } from "./drafter";
import { buildGraph, findStall } from "./graph";
import { SAMPLE_LETTERS } from "./samples";
import type { Coverage, Stall } from "./types";

const AS_OF = "2026-07-15";
const GRAPH = buildGraph(SAMPLE_LETTERS.map((letter) => letter.extraction));

/** The goal node the letters name — the fixtures' JAK inhibitor approval. */
const GOAL_NODE = GRAPH.nodes.find((node) => node.id === GRAPH.goal.nodeId)!;

/** The demo stall: the repeat CT chest, overdue and blocking the approval. */
const CT_STALL = findStall(GRAPH, AS_OF)!;

/** The terminal treatment approval, presented as if it were the bottleneck. */
const APPROVAL_STALL: Stall = {
  stalledNode: GOAL_NODE,
  chain: [GOAL_NODE],
  owningDept: "Gastroenterology",
  sinceDate: "2026-03-20",
  daysStalled: 117,
  expectedDays: 28,
  dueDate: null,
  daysOverdue: 89,
  explanation: "Jak inhibitor approval cannot go ahead until it is resolved.",
};

const PLAN: Coverage = {
  plan_type: "Sample Health Comprehensive (employer)",
  covers_diagnostics: true,
  covers_consults: true,
  requires_gp_referral: false,
  requires_preauth: true,
  excludes: [],
  confidence: 0.9,
};

const META = { patient_name: "A. Patel", hospital: "St Mary's Hospital", nhs_number: "123 456 7890" };

const CT_HATCH = escapeHatch(CT_STALL, PLAN)!;
const APPROVAL_HATCH = escapeHatch(APPROVAL_STALL, PLAN)!;

describe("private-route drafting", () => {
  it("drafts an insurer pre-auth request from the template alone", async () => {
    const result = await draft({
      stall: CT_STALL,
      vitals: null,
      target: "insurer_preauth",
      escapeHatch: CT_HATCH,
      meta: META,
    });
    expect(result.target).toBe("insurer_preauth");
    expect(result.text).toContain("pre-authorisation");
    expect(result.text).toContain(CT_HATCH.node.label);
    expect(result.text).toContain(CT_HATCH.providers[0].name);
    // Exactly one requested date, and the NHS route is explicitly not abandoned.
    expect(result.text).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(result.text).toContain("NHS referral remains open");
  });

  it("drafts the NHS notice with the report returned to the NHS team", async () => {
    const result = await draft({
      stall: CT_STALL,
      vitals: null,
      target: "nhs_private_notice",
      escapeHatch: CT_HATCH,
      meta: META,
    });
    expect(result.text).toContain("report to be sent directly to you");
    expect(result.text).toContain("without a duplicate test");
  });

  it("never drafts a private-route message for the jak inhibitor approval", async () => {
    expect(APPROVAL_HATCH.coverable).toBe(false);
    for (const target of ["insurer_preauth", "nhs_private_notice"] as const) {
      await expect(
        draft({ stall: APPROVAL_STALL, vitals: null, target, escapeHatch: APPROVAL_HATCH, meta: META }),
      ).rejects.toThrow(/cannot be routed privately/);
    }
  });

  it("refuses a private-route draft with no escape hatch at all", async () => {
    await expect(
      draft({ stall: CT_STALL, vitals: null, target: "insurer_preauth", meta: META }),
    ).rejects.toThrow(/requires escapeHatch/);
  });

  it("leaves the existing NHS escalation drafts untouched", async () => {
    const result = await draft({ stall: CT_STALL, vitals: null, target: "pals", meta: META });
    expect(result.text).toContain("Dear PALS team");
    expect(result.text).not.toContain("privately");
    expect(result.text).not.toContain("insurer");
  });
});
