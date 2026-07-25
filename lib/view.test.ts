import { describe, expect, it } from "vitest";
import type { GraphNode, PathwayGraph, Stall } from "@/lib/pipeline/types";
import { buildPathwayView, noStallHeadline } from "@/lib/view";

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label: id,
    dept: null,
    kind: "investigation",
    invType: null,
    status: "unknown",
    ordered_date: null,
    report_date: null,
    expected_days: null,
    ...over,
  };
}

/** referral → clinic → xray → funding, plus one unrelated item. */
function graph(over: Partial<PathwayGraph> = {}): PathwayGraph {
  return {
    nodes: [
      node("referral", { ordered_date: "2026-01-20", status: "done" }),
      node("clinic", { ordered_date: "2026-02-06", status: "done" }),
      node("xray", { ordered_date: "2026-02-06" }),
      node("funding", { dept: "Imperial Gastroenterology" }),
      node("unrelated", { ordered_date: "2025-11-02" }),
    ],
    edges: [
      { from: "referral", to: "clinic", kind: "blocks" },
      { from: "clinic", to: "xray", kind: "blocks" },
      { from: "xray", to: "funding", kind: "blocks" },
    ],
    ...over,
  };
}

const stall: Stall = {
  stalledNode: node("xray", { ordered_date: "2026-02-06" }),
  chain: [node("xray"), node("funding")],
  owningDept: "Imperial Gastroenterology",
  sinceDate: "2026-02-06",
  daysStalled: 169,
  expectedDays: 28,
};

describe("buildPathwayView", () => {
  it("prefers the chain and goal the API supplies", () => {
    const view = buildPathwayView(
      graph({
        chainIds: ["referral", "clinic", "xray", "funding"],
        goal: { nodeId: "funding", label: "Start filgotinib", dept: "Imperial", source: "stated" },
      }),
      stall,
    );
    expect(view.chain.map((n) => n.id)).toEqual(["referral", "clinic", "xray", "funding"]);
    expect(view.goal?.label).toBe("Start filgotinib");
    expect(view.others.map((n) => n.id)).toEqual(["unrelated"]);
  });

  it("derives the chain from edges until the backend sends chainIds", () => {
    const view = buildPathwayView(graph(), stall);
    expect(view.chain.map((n) => n.id)).toEqual(["referral", "clinic", "xray", "funding"]);
    expect(view.goal?.nodeId).toBe("funding");
    expect(view.goal?.source).toBe("inferred");
  });

  it("points at the stalled node as where the pathway currently sits", () => {
    expect(buildPathwayView(graph(), stall).current?.id).toBe("xray");
  });

  it("falls back to the first unsettled step when nothing is stalled", () => {
    expect(buildPathwayView(graph(), null).current?.id).toBe("xray");
  });

  it("orders undated, edgeless graphs by date rather than dropping them", () => {
    const flat = buildPathwayView(
      {
        nodes: [node("b", { ordered_date: "2026-02-06" }), node("a", { ordered_date: "2026-01-20" })],
        edges: [],
      },
      null,
    );
    expect(flat.chain.map((n) => n.id)).toEqual(["a", "b"]);
    expect(flat.others).toEqual([]);
  });

  it("survives a cyclic graph", () => {
    const cyclic = buildPathwayView(
      {
        nodes: [node("a"), node("b")],
        edges: [
          { from: "a", to: "b", kind: "blocks" },
          { from: "b", to: "a", kind: "blocks" },
        ],
      },
      null,
    );
    expect(cyclic.chain.length).toBeGreaterThan(0);
  });

  it("is empty for a null graph", () => {
    expect(buildPathwayView(null, null)).toEqual({ chain: [], others: [], goal: null, current: null });
  });
});

describe("noStallHeadline", () => {
  it("says why, per code", () => {
    expect(noStallHeadline({ code: "no_dated_steps", message: "" })).toMatch(/dated steps/i);
    expect(noStallHeadline({ code: "within_expected_windows", message: "" })).toMatch(/expected window/i);
    expect(noStallHeadline(null)).toMatch(/no overdue step/i);
  });
});
