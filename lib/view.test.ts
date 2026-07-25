import { describe, expect, it } from "vitest";
import type { GraphNode, PathwayGraph, Stall } from "@/lib/pipeline/types";
import {
  buildPathwayView,
  buildTimeline,
  describeSpan,
  noStallHeadline,
  timelineOrder,
  timelineSpanLabel,
} from "@/lib/view";

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

describe("buildTimeline", () => {
  const timeline = (g = graph(), s: Stall | null = null) => buildTimeline(buildPathwayView(g, s), s);

  it("lays the dated steps out oldest first", () => {
    expect(timeline().dated.map((e) => e.node.id)).toEqual(["referral", "clinic", "xray"]);
  });

  it("holds an undated, unfinished goal back as the destination", () => {
    const t = timeline();
    expect(t.destination?.node.id).toBe("funding");
    expect(t.dated.some((e) => e.node.id === "funding")).toBe(false);
  });

  it("puts a goal that already happened on the rail at its own date", () => {
    const g = graph({
      nodes: [
        node("referral", { ordered_date: "2026-01-20", status: "done" }),
        node("funding", { report_date: "2026-03-02", status: "reported" }),
      ],
      chainIds: ["referral", "funding"],
    });
    const t = timeline(g);
    expect(t.destination).toBeNull();
    expect(t.dated.map((e) => e.node.id)).toEqual(["referral", "funding"]);
  });

  it("keeps months with nothing in them, so a gap reads as a gap", () => {
    const g = graph({
      nodes: [
        node("a", { ordered_date: "2026-01-12" }),
        node("b", { ordered_date: "2026-04-18" }),
      ],
      chainIds: ["a", "b"],
      goal: { nodeId: "b", label: "b", dept: null, source: "derived" },
    });
    const t = timeline(g);
    expect(t.months.map((m) => m.key)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(t.months.filter((m) => m.entries.length === 0).map((m) => m.key)).toEqual([
      "2026-02",
      "2026-03",
    ]);
  });

  it("drops the empty-month axis once the span is too long to be useful", () => {
    const g = graph({
      nodes: [node("a", { ordered_date: "2021-01-12" }), node("b", { ordered_date: "2026-04-18" })],
      chainIds: ["a", "b"],
      goal: { nodeId: "b", label: "b", dept: null, source: "derived" },
    });
    expect(timeline(g).months.map((m) => m.key)).toEqual(["2021-01", "2026-04"]);
  });

  it("keeps an undated step visible instead of dropping it", () => {
    const g = graph({
      nodes: [node("a", { ordered_date: "2026-01-12" }), node("culture"), node("funding")],
      chainIds: ["a", "culture", "funding"],
    });
    const t = timeline(g);
    expect(t.undated.map((e) => e.node.id)).toEqual(["culture"]);
    expect(t.destination?.node.id).toBe("funding");
  });

  it("degrades an unparseable date to undated rather than rendering it", () => {
    const g = graph({
      nodes: [node("a", { ordered_date: "not-a-date" }), node("funding")],
      chainIds: ["a", "funding"],
    });
    const t = timeline(g);
    expect(t.undated.map((e) => e.node.id)).toEqual(["a"]);
    expect(t.dated).toEqual([]);
    expect(t.months).toEqual([]);
  });

  it("marks only the stalled step overdue, reporting what the API computed", () => {
    const t = timeline(graph(), stall);
    const overdue = t.dated.filter((e) => e.overdue);
    expect(overdue.map((e) => e.node.id)).toEqual(["xray"]);
    expect(overdue[0].overdue?.phrase).toBe("waiting 6 months");
    expect(overdue[0].overdue?.detail).toBe("expected within 28 days");
  });

  it("never invents a due date the API didn't give", () => {
    const t = timeline(graph(), { ...stall, expectedDays: null });
    expect(t.dated.find((e) => e.node.id === "xray")?.overdue?.detail).toBeNull();
  });

  it("names a slow turnaround but stays quiet about a quick one (AC7)", () => {
    const g = graph({
      nodes: [
        node("slow", { ordered_date: "2026-02-06", report_date: "2026-03-13" }),
        node("quick", { ordered_date: "2026-03-13", report_date: "2026-03-16" }),
        node("funding"),
      ],
      chainIds: ["slow", "quick", "funding"],
    });
    const byId = new Map(timeline(g).dated.map((e) => [e.node.id, e]));
    expect(byId.get("slow")?.turnaroundDays).toBe(35);
    expect(byId.get("quick")?.turnaroundDays).toBeNull();
  });

  it("flags finished steps as settled so they can recede", () => {
    const byId = new Map(timeline().dated.map((e) => [e.node.id, e.settled]));
    expect(byId.get("referral")).toBe(true);
    expect(byId.get("xray")).toBe(false);
  });

  it("orders every chain step exactly once, dated then undated then goal", () => {
    const g = graph({
      nodes: [node("a", { ordered_date: "2026-01-12" }), node("culture"), node("funding")],
      chainIds: ["a", "culture", "funding"],
    });
    expect(timelineOrder(timeline(g)).map((e) => e.node.id)).toEqual(["a", "culture", "funding"]);
  });

  it("is empty for a pathway with no steps at all", () => {
    const t = buildTimeline(buildPathwayView(null, null), null);
    expect(t).toEqual({ months: [], dated: [], undated: [], destination: null });
  });
});

describe("timelineSpanLabel", () => {
  it("states the arc from first step to last", () => {
    const label = timelineSpanLabel(buildTimeline(buildPathwayView(graph(), null), null));
    expect(label).toBe("20 Jan – 6 Feb 2026 · 2 weeks");
  });

  it("has nothing to say when no step is dated", () => {
    expect(timelineSpanLabel(buildTimeline(buildPathwayView(null, null), null))).toBeNull();
  });
});

describe("describeSpan", () => {
  it("talks in the units the letters use", () => {
    expect(describeSpan(1)).toBe("1 day");
    expect(describeSpan(4)).toBe("4 days");
    expect(describeSpan(35)).toBe("5 weeks");
    expect(describeSpan(24)).toBe("3 weeks");
    expect(describeSpan(169)).toBe("6 months");
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
