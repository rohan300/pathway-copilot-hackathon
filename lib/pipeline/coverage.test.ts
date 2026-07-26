/**
 * Coverage matching is deterministic, so these tests are the specification:
 * the same stall and the same plan must always produce the same answer, and
 * the treatment approval must never be routed privately.
 */

import { describe, expect, it } from "vitest";
import { escapeHatch } from "./coverage";
import { buildGraph, findStall } from "./graph";
import { providersFor } from "./providers";
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

function plan(overrides: Partial<Coverage> = {}): Coverage {
  return {
    plan_type: "Sample Health Comprehensive (employer)",
    covers_diagnostics: true,
    covers_consults: true,
    requires_gp_referral: false,
    requires_preauth: false,
    excludes: [],
    confidence: 0.9,
    ...overrides,
  };
}

describe("escapeHatch", () => {
  it("offers the stalled repeat CT when the plan covers diagnostics", () => {
    const hatch = escapeHatch(CT_STALL, plan())!;

    expect(hatch.node.label).toBe("Repeat CT chest");
    expect(hatch.coverable).toBe(true);
    expect(hatch.providers.length).toBeGreaterThan(0);
    expect(hatch.providers).toEqual(providersFor("ct"));
    expect(hatch.providers.every((provider) => provider.invTypes.includes("ct"))).toBe(true);
    // The positioning rule: the diagnostic step, never the treatment behind it.
    expect(hatch.reason).toMatch(/diagnostic step only — not the ongoing treatment/);
  });

  it("does not offer the same stall when the plan excludes diagnostics", () => {
    const hatch = escapeHatch(CT_STALL, plan({ covers_diagnostics: false }))!;

    expect(hatch.coverable).toBe(false);
    expect(hatch.providers).toEqual([]);
    expect(hatch.reason).toMatch(/does not cover diagnostic tests/);
  });

  it("NEVER offers the jak inhibitor approval privately, even on the most generous plan", () => {
    const mostGenerous = plan({
      plan_type: "Sample Health Platinum (no exclusions)",
      covers_diagnostics: true,
      covers_consults: true,
      excludes: [],
      confidence: 1,
    });

    const hatch = escapeHatch(APPROVAL_STALL, mostGenerous)!;

    expect(hatch.node.id).toBe(GRAPH.goal.nodeId);
    expect(hatch.coverable).toBe(false);
    expect(hatch.providers).toEqual([]);
    expect(hatch.reason).toMatch(/chronic/i);
    expect(hatch.reason).toMatch(/cannot be routed privately under any plan/);
  });

  it("does not offer a step matched by the plan's excludes list", () => {
    const hatch = escapeHatch(CT_STALL, plan({ excludes: ["CT"] }))!;

    expect(hatch.coverable).toBe(false);
    expect(hatch.providers).toEqual([]);
    expect(hatch.reason).toMatch(/exclusion/);
  });

  it("surfaces pre-authorisation and GP-referral requirements in the caveats", () => {
    const hatch = escapeHatch(CT_STALL, plan({ requires_preauth: true, requires_gp_referral: true }))!;

    expect(hatch.coverable).toBe(true);
    expect(hatch.caveats.some((caveat) => /pre-authorisation/i.test(caveat))).toBe(true);
    expect(hatch.caveats.some((caveat) => /GP referral/i.test(caveat))).toBe(true);
    expect(hatch.caveats.some((caveat) => /[Ii]ndicative only/.test(caveat))).toBe(true);
    expect(hatch.caveats.some((caveat) => /not medical advice/i.test(caveat))).toBe(true);
  });

  it("is deterministic — repeated calls on the same input are identical", () => {
    const once = escapeHatch(CT_STALL, plan());
    const twice = escapeHatch(CT_STALL, plan());
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

describe("providersFor", () => {
  it("returns only clinics offering the type, nearest wait first", () => {
    const ct = providersFor("ct");
    expect(ct.length).toBeGreaterThanOrEqual(2);
    expect(ct.every((provider) => provider.invTypes.includes("ct"))).toBe(true);
    expect(ct.map((provider) => provider.indicative_wait_days)).toEqual(
      [...ct.map((provider) => provider.indicative_wait_days)].sort((a, b) => a - b),
    );
  });

  it("covers the types that can actually stall in the demo chain", () => {
    expect(providersFor("bronchoscopy").length).toBeGreaterThan(0);
    expect(providersFor("mri").length).toBeGreaterThan(0);
    expect(providersFor("consult").length).toBeGreaterThan(0);
  });

  it("narrows by region rather than offering a distant clinic", () => {
    expect(providersFor("ct", "London").every((provider) => provider.region === "London")).toBe(true);
    expect(providersFor("ct", "Orkney")).toEqual([]);
  });
});
