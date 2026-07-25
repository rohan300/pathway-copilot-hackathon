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

/** referral → clinic → xray → funding, plus one item off the chain. */
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
    goal: { nodeId: "funding", label: "Start filgotinib", dept: "Imperial Gastroenterology", source: "stated" },
    chainIds: ["referral", "clinic", "xray", "funding"],
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
  it("reads the chain and goal straight off the API", () => {
    const view = buildPathwayView(graph(), stall);
    expect(view.chain.map((n) => n.id)).toEqual(["referral", "clinic", "xray", "funding"]);
    expect(view.goal?.label).toBe("Start filgotinib");
  });

  it("demotes everything off chainIds, oldest first", () => {
    expect(buildPathwayView(graph(), null).others.map((n) => n.id)).toEqual(["unrelated"]);
  });

  it("appends steps the stall names that chainIds omitted", () => {
    const view = buildPathwayView(graph({ chainIds: ["referral", "clinic"] }), stall);
    expect(view.chain.map((n) => n.id)).toEqual(["referral", "clinic", "xray", "funding"]);
    expect(view.others.map((n) => n.id)).toEqual(["unrelated"]);
  });

  it("points at the stalled node as where the pathway currently sits", () => {
    expect(buildPathwayView(graph(), stall).current?.id).toBe("xray");
  });

  it("falls back to the first unsettled step when nothing is stalled", () => {
    expect(buildPathwayView(graph(), null).current?.id).toBe("xray");
  });

  it("tolerates chainIds naming a node the graph doesn't carry", () => {
    const view = buildPathwayView(graph({ chainIds: ["referral", "ghost", "funding"] }), null);
    expect(view.chain.map((n) => n.id)).toEqual(["referral", "funding"]);
  });

  it("is empty for a null graph", () => {
    expect(buildPathwayView(null, null)).toEqual({ chain: [], others: [], goal: null, current: null });
  });
});

describe("noStallHeadline", () => {
  it("says why, against the codes explainNoStall actually emits", () => {
    expect(noStallHeadline({ code: "no_dated_nodes", message: "" })).toMatch(/dated steps/i);
    expect(noStallHeadline({ code: "no_path_to_goal", message: "" })).toMatch(/connects to your goal/i);
    expect(noStallHeadline({ code: "nothing_overdue", message: "" })).toMatch(/expected window/i);
  });

  it("never renders a bare fallback for a real API reason", () => {
    const generic = noStallHeadline(null);
    for (const code of ["no_dated_nodes", "no_path_to_goal", "nothing_overdue"] as const) {
      expect(noStallHeadline({ code, message: "" })).not.toBe(generic);
    }
  });
});
