/**
 * The demo fixtures in samples.ts are the oracle: every letter carries a
 * hand-authored, internally consistent extraction, so the graph they produce is
 * the expected graph. These tests assert the deterministic layer only — no LLM.
 */

import { describe, expect, it } from "vitest";
import { buildGraph, findStall, TERMINAL_ID } from "./graph";
import { SAMPLE_LETTERS } from "./samples";
import type { Extraction } from "./types";

const EXTRACTIONS = SAMPLE_LETTERS.map((letter) => letter.extraction);

/** Deep-copy so a mutation in one test cannot leak into another. */
function clone(extractions: Extraction[]): Extraction[] {
  return JSON.parse(JSON.stringify(extractions)) as Extraction[];
}

function labels(nodes: { label: string }[]): string[] {
  return nodes.map((node) => node.label);
}

describe("buildGraph", () => {
  it("joins the TB chain across both departments and terminates at approval", () => {
    const graph = buildGraph(EXTRACTIONS);

    expect(labels(graph.nodes)).toEqual([
      "TB screening bloods",
      "TB-screening chest X-ray",
      "Incidental pulmonary finding requiring further review",
      "CT chest",
      "CT report requires bronchoscopy before Respiratory clearance",
      "Respiratory clearance",
      "Bronchoscopy",
      "Bronchoscopy report requests a repeat CT chest",
      "Repeat CT chest",
      "Jak inhibitor approval",
    ]);

    const terminal = graph.nodes.find((node) => node.id === TERMINAL_ID);
    expect(terminal).toMatchObject({ kind: "approval", dept: "Gastroenterology", status: "awaiting" });

    // The stalled node's SLA comes from its normalized investigation type.
    const repeatCt = graph.nodes.find((node) => node.label === "Repeat CT chest")!;
    expect(repeatCt).toMatchObject({
      kind: "investigation",
      invType: "ct",
      dept: "Respiratory",
      status: "ordered",
      ordered_date: "2026-06-10",
      report_date: null,
      expected_days: 21,
    });
  });

  it("derives edges only from stated findings and dependencies", () => {
    const graph = buildGraph(EXTRACTIONS);
    const id = (label: string) => graph.nodes.find((node) => node.label === label)!.id;

    // finding.on_investigation -> finding -> finding.spawned
    expect(graph.edges).toContainEqual({
      from: id("TB-screening chest X-ray"),
      to: id("Incidental pulmonary finding requiring further review"),
      kind: "spawned_by",
    });
    expect(graph.edges).toContainEqual({
      from: id("Incidental pulmonary finding requiring further review"),
      to: id("CT chest"),
      kind: "spawned_by",
    });

    // dependencies: blocking_item -> blocked_item, "awaiting" as stated
    expect(graph.edges).toContainEqual({
      from: id("Repeat CT chest"),
      to: id("Respiratory clearance"),
      kind: "awaiting",
    });
    expect(graph.edges).toContainEqual({
      from: id("Respiratory clearance"),
      to: TERMINAL_ID,
      kind: "awaiting",
    });

    // No edge is invented between departments without a stated join.
    expect(graph.edges.some((edge) => edge.from === id("TB screening bloods"))).toBe(false);
  });
});

describe("findStall", () => {
  it("flags the repeat CT as the upstream root, with the chain to approval", () => {
    const graph = buildGraph(EXTRACTIONS);
    const stall = findStall(graph, "2026-07-15")!;

    expect(stall.stalledNode.label).toBe("Repeat CT chest");
    expect(stall.owningDept).toBe("Respiratory");
    expect(stall.sinceDate).toBe("2026-06-10");
    expect(stall.daysStalled).toBe(35); // 2026-06-10 -> 2026-07-15
    expect(stall.expectedDays).toBe(21);
    expect(labels(stall.chain)).toEqual([
      "Repeat CT chest",
      "Respiratory clearance",
      "Jak inhibitor approval",
    ]);
  });

  it("returns null while every open item is still inside its expected window", () => {
    // Letters 1-3 only: every investigation is reported, nothing is overdue.
    const graph = buildGraph(clone(EXTRACTIONS).slice(0, 3));
    expect(findStall(graph, "2026-04-20")).toBeNull();
  });

  it("moves the stall downstream once the repeat CT is reported", () => {
    const extractions = clone(EXTRACTIONS);
    const repeatCt = extractions[5].investigations[0];
    repeatCt.report_date = "2026-06-20";
    repeatCt.status = "reported";

    const stall = findStall(buildGraph(extractions), "2026-07-15")!;
    expect(stall.stalledNode.label).toBe("Respiratory clearance");
    expect(stall.owningDept).toBe("Respiratory");
    expect(stall.sinceDate).toBe("2026-04-16");
    expect(stall.daysStalled).toBe(90); // 2026-04-16 -> 2026-07-15
    expect(labels(stall.chain)).toEqual(["Respiratory clearance", "Jak inhibitor approval"]);
  });
});
