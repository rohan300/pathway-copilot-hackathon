/**
 * The demo fixtures in samples.ts are the oracle: every letter carries a
 * hand-authored, internally consistent extraction, so the graph they produce is
 * the expected graph. These tests assert the deterministic layer only — no LLM.
 */

import { describe, expect, it } from "vitest";
import { buildGraph, explainNoStall, findStall } from "./graph";
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

    // The findings the letters report are NOT in this list, and that is the
    // change: a finding is the join between the step it came off and the step
    // it caused, not a step of its own. The old expectation listed all three of
    // them as nodes, which put un-chaseable prose ("CT report requires
    // bronchoscopy before Respiratory clearance") on the pathway and inserted a
    // node into the chain between an investigation and what it led to.
    expect(labels(graph.nodes)).toEqual([
      "TB screening bloods",
      "TB-screening chest X-ray",
      "CT chest",
      "Respiratory clearance",
      "Bronchoscopy",
      "Repeat CT chest",
      "Jak inhibitor approval",
    ]);
    expect(graph.nodes.some((node) => node.kind === "finding")).toBe(false);

    const terminal = graph.nodes.find((node) => node.id === graph.goal.nodeId);
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

    // A finding joins the step it was reported on straight to the step it
    // caused: finding.on_investigation -> finding.spawned. The old assertion
    // routed this through a node for the finding itself, which is the thing
    // that is no longer built.
    expect(graph.edges).toContainEqual({
      from: id("TB-screening chest X-ray"),
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
      to: graph.goal.nodeId,
      kind: "awaiting",
    });

    // No edge is invented between departments without a stated join. Happening
    // earlier is not a dependency: the step is placed on the timeline by its
    // own date, and nothing claims the next step was waiting on it.
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

/**
 * The regression this ticket exists for. These extractions mirror the three
 * real letters a user uploaded (no PDFs committed): a private gastro letter,
 * a GP referral, and the first Imperial clinic that orders pre-biologic
 * screening. Nothing in them mentions a JAK inhibitor, none of them writes an
 * "awaiting X before Y" dependency, and the app answered "33 nodes, no
 * bottleneck" — five months after the screening was ordered.
 */
const REAL_LETTERS: Extraction[] = [
  {
    letter_date: "2026-01-12",
    department: "Gastroenterology",
    clinicians: [{ name: "Dr Peake", dept: "Gastroenterology" }],
    investigations: [
      {
        id: "gastro-consultation-1",
        name: "Gastroenterology consultation",
        type: "consult",
        ordered_date: "2026-01-12",
        report_date: "2026-01-12",
        status: "reported",
      },
    ],
    findings: [
      // Background prose: no investigation joined, nothing spawned.
      { text: "Likely he will need an advanced medical therapy", on_investigation: null, spawned: null },
      { text: "Symptoms remain troublesome despite current treatment", on_investigation: null, spawned: null },
    ],
    referrals: [
      {
        from_dept: "Gastroenterology",
        to_dept: "Gastroenterology (Imperial)",
        reason: "Referral for consideration of advanced medical therapy",
        date: "2026-01-12",
      },
    ],
    dependencies: [],
    mdt: [],
    stated_goal: null,
    confidence: 0.9,
  },
  {
    letter_date: "2026-01-20",
    department: "General Practice",
    clinicians: [],
    investigations: [
      {
        id: "gp-consultation-1",
        name: "GP consultation",
        type: "consult",
        ordered_date: "2026-01-19",
        report_date: "2026-01-19",
        status: "reported",
      },
    ],
    findings: [],
    referrals: [
      {
        from_dept: "General Practice",
        to_dept: "Gastroenterology (Imperial)",
        reason: "Referral to Dr Peake at St Mary's",
        date: "2026-01-20",
      },
    ],
    dependencies: [],
    mdt: [],
    stated_goal: null,
    confidence: 0.92,
  },
  {
    letter_date: "2026-02-06",
    department: "Gastroenterology (Imperial)",
    clinicians: [{ name: "Dr Peake", dept: "Gastroenterology (Imperial)" }],
    investigations: [
      {
        id: "imperial-clinic-1",
        name: "Imperial Gastroenterology clinic",
        type: "consult",
        ordered_date: "2026-02-06",
        report_date: "2026-02-06",
        status: "reported",
      },
      {
        id: "prebiologic-screening-bloods-1",
        name: "Pre-biologic screening bloods",
        type: "bloods",
        ordered_date: "2026-02-06",
        report_date: null,
        status: "ordered",
      },
      {
        id: "chest-xray-1",
        name: "Chest X-ray",
        type: "xray",
        ordered_date: "2026-02-06",
        report_date: null,
        status: "ordered",
      },
      // The same X-ray named a second time with no date: one step, not two.
      {
        id: "chest-xray-2",
        name: "chest x-ray",
        type: "xray",
        ordered_date: null,
        report_date: null,
        status: "unknown",
      },
      {
        id: "funding-application-1",
        name: "Funding application for filgotinib",
        type: "other",
        ordered_date: "2026-02-06",
        report_date: null,
        status: "ordered",
      },
    ],
    findings: [
      { text: "Filgotinib proposed as the next line of therapy", on_investigation: null, spawned: null },
    ],
    referrals: [],
    dependencies: [],
    mdt: [],
    stated_goal: "Start filgotinib",
    confidence: 0.88,
  },
];

describe("real uploaded letters (no stated dependencies, no JAK inhibitor)", () => {
  const AS_OF = "2026-07-25";

  it("infers the goal the latest letter names and never invents the JAK label", () => {
    const graph = buildGraph(clone(REAL_LETTERS));

    expect(graph.goal).toMatchObject({
      label: "Start filgotinib",
      dept: "Gastroenterology (Imperial)",
      source: "stated",
    });
    expect(labels(graph.nodes).join(" | ")).not.toMatch(/jak/i);
  });

  it("keeps the node count sane: dedups repeats and drops background prose", () => {
    const graph = buildGraph(clone(REAL_LETTERS));

    expect(graph.nodes.length).toBeGreaterThanOrEqual(6);
    expect(graph.nodes.length).toBeLessThanOrEqual(12);
    // The X-ray is written twice across one letter and is still one node.
    expect(graph.nodes.filter((node) => node.invType === "xray")).toHaveLength(1);
    // Prose that joins nothing is not a pathway step.
    expect(graph.nodes.some((node) => /troublesome/i.test(node.label))).toBe(false);
  });

  it("flags the overdue pre-biologic screening with a chain reaching the goal", () => {
    const graph = buildGraph(clone(REAL_LETTERS));
    const stall = findStall(graph, AS_OF)!;

    expect(stall.stalledNode.label).toBe("Pre-biologic screening bloods");
    expect(stall.owningDept).toBe("Gastroenterology (Imperial)");
    expect(stall.sinceDate).toBe("2026-02-06");
    expect(stall.daysStalled).toBe(169); // 2026-02-06 -> 2026-07-25
    expect(stall.chain[stall.chain.length - 1].id).toBe(graph.goal.nodeId);
    expect(graph.chainIds).toContain(stall.stalledNode.id);
    expect(graph.chainIds[graph.chainIds.length - 1]).toBe(graph.goal.nodeId);
  });

  it("derives the goal from treatment wording when no letter states one", () => {
    const extractions = clone(REAL_LETTERS);
    extractions[2].stated_goal = null;

    const graph = buildGraph(extractions);
    // "…consideration of advanced medical therapy" is the letters' own wording.
    expect(graph.goal).toMatchObject({ label: "Start advanced medical therapy", source: "derived" });
  });

  it("falls back to a generic goal when no letter states an intent", () => {
    const extractions = clone(REAL_LETTERS);
    extractions[2].stated_goal = null;
    extractions[2].findings = [];
    extractions[2].investigations = extractions[2].investigations.filter(
      (item) => !/filgotinib/i.test(item.name),
    );
    extractions[0].findings = [];
    extractions[0].referrals[0].reason = "Referral to the Imperial IBD service";

    const graph = buildGraph(extractions);
    expect(graph.goal.source).toBe("fallback");
    expect(graph.goal.label).toBe("Treatment decision");
  });
});

describe("explainNoStall", () => {
  it("says nothing is overdue when every open step is inside its window", () => {
    const graph = buildGraph(clone(EXTRACTIONS).slice(0, 3));
    expect(findStall(graph, "2026-04-20")).toBeNull();
    expect(explainNoStall(graph, "2026-04-20")).toMatchObject({ code: "nothing_overdue" });
  });

  it("says so when not one step carries a date", () => {
    const extractions = clone(REAL_LETTERS).map((extraction) => ({
      ...extraction,
      letter_date: null,
      investigations: extraction.investigations.map((item) => ({
        ...item,
        ordered_date: null,
        report_date: null,
      })),
      referrals: extraction.referrals.map((item) => ({ ...item, date: null })),
    }));

    const graph = buildGraph(extractions);
    expect(findStall(graph, "2026-07-25")).toBeNull();
    expect(explainNoStall(graph, "2026-07-25")).toMatchObject({ code: "no_dated_nodes" });
  });

  it("says so when open steps exist but none connects to the goal", () => {
    const graph = buildGraph(clone(EXTRACTIONS));
    // Strip every edge: the open repeat CT can no longer reach the approval.
    const disconnected = { ...graph, edges: [], chainIds: [graph.goal.nodeId] };

    expect(findStall(disconnected, "2026-07-15")).toBeNull();
    expect(explainNoStall(disconnected, "2026-07-15")).toMatchObject({ code: "no_path_to_goal" });
  });
});

/**
 * The rules that decide when two mentions are one step. Written against
 * minimal, purpose-built extractions rather than the demo corpus, so each test
 * states the rule it is protecting instead of blessing a number this particular
 * set of letters happens to produce.
 */
describe("same step, written up twice", () => {
  const letter = (over: Partial<Extraction>): Extraction => ({
    letter_date: null,
    department: "Respiratory",
    clinicians: [],
    investigations: [],
    findings: [],
    referrals: [],
    dependencies: [],
    mdt: [],
    confidence: 1,
    ...over,
  });

  const inv = (
    name: string,
    type: Extraction["investigations"][number]["type"],
    status: Extraction["investigations"][number]["status"],
    dates: { ordered_date?: string | null; report_date?: string | null } = {},
  ) => ({
    id: name,
    name,
    type,
    status,
    ordered_date: dates.ordered_date ?? null,
    report_date: dates.report_date ?? null,
  });

  it("rejoins a step a later letter merely restates, instead of ordering it again", () => {
    const graph = buildGraph([
      letter({ letter_date: "2026-03-13", investigations: [inv("chest x-ray", "xray", "done", { report_date: "2026-03-13" })] }),
      letter({ letter_date: "2026-06-23", investigations: [inv("CXR", "xray", "ordered")] }),
    ], "2026-07-25");

    const xrays = graph.nodes.filter((node) => node.invType === "xray");
    expect(labels(xrays)).toEqual(["chest x-ray"]);
    expect(xrays[0].status).toBe("done");
    // The June letter recounting a March result must not date the request to
    // June — that would put the request after its own report.
    expect(xrays[0].ordered_date).toBeNull();
  });

  it("keeps a repeat apart from the completed step it repeats", () => {
    const graph = buildGraph([
      letter({ letter_date: "2026-04-18", investigations: [inv("CT thorax", "ct", "reported", { report_date: "2026-04-18" })] }),
      letter({ letter_date: "2026-05-12", investigations: [inv("repeat non-contrast CT scan", "ct", "ordered")] }),
    ], "2026-07-25");

    const cts = graph.nodes.filter((node) => node.invType === "ct");
    expect(cts).toHaveLength(2);
    expect(cts.filter((node) => node.status === "reported")).toHaveLength(1);
    expect(cts.filter((node) => node.status === "ordered")).toHaveLength(1);
  });

  it("sends a later plain re-request to the open repeat, not the finished original", () => {
    const graph = buildGraph([
      letter({ letter_date: "2026-04-18", investigations: [inv("CT thorax", "ct", "reported", { report_date: "2026-04-18" })] }),
      letter({ letter_date: "2026-05-12", investigations: [inv("repeat non-contrast CT scan", "ct", "ordered")] }),
      letter({ letter_date: "2026-06-23", investigations: [inv("CT chest", "ct", "ordered", { ordered_date: "2026-06-23" })] }),
    ], "2026-07-25");

    const cts = graph.nodes.filter((node) => node.invType === "ct");
    expect(cts).toHaveLength(2);
    const done = cts.find((node) => node.status === "reported")!;
    const open = cts.find((node) => node.status === "ordered")!;
    // The completed scan keeps its own date; the June re-request belongs to the
    // repeat that is still outstanding.
    expect(done.report_date).toBe("2026-04-18");
    expect(done.ordered_date).toBeNull();
    expect(open.ordered_date).toBe("2026-05-12");
  });

  it("does not let a one-letter word in a listed panel split it from the same panel named plainly", () => {
    const graph = buildGraph([
      letter({ letter_date: "2026-02-06", investigations: [inv("prebiological screening blood test", "bloods", "ordered")] }),
      letter({ letter_date: "2026-02-20", investigations: [inv("routine blood tests including tests for Lipids, TB, HIV, Varicella, Hep B, Hep C", "bloods", "ordered")] }),
    ], "2026-07-25");

    expect(graph.nodes.filter((node) => node.invType === "bloods")).toHaveLength(1);
  });

  it("makes a finding the join between two steps and never a step itself", () => {
    const graph = buildGraph([
      letter({
        letter_date: "2026-05-01",
        investigations: [inv("chest x-ray", "xray", "reported"), inv("CT chest", "ct", "ordered")],
        findings: [{ text: "Right upper zone consolidation", on_investigation: "chest x-ray", spawned: "CT chest" }],
      }),
    ], "2026-07-25");

    expect(graph.nodes.some((node) => node.kind === "finding")).toBe(false);
    expect(graph.nodes.some((node) => /consolidation/i.test(node.label))).toBe(false);
    const xray = graph.nodes.find((node) => node.invType === "xray")!;
    const ct = graph.nodes.find((node) => node.invType === "ct")!;
    expect(graph.edges).toContainEqual({ from: xray.id, to: ct.id, kind: "spawned_by" });
  });
});

describe("a promise the letters make", () => {
  const letter = (over: Partial<Extraction>): Extraction => ({
    letter_date: null,
    department: "Respiratory Medicine",
    clinicians: [],
    investigations: [],
    findings: [],
    referrals: [],
    dependencies: [],
    mdt: [],
    confidence: 1,
    ...over,
  });

  const promise = (item: string, phrase: string | null, due_date: string | null = null) => ({
    item,
    phrase,
    from: null,
    due_date,
  });

  /** The 23-Jun letter's "FU 4 weeks", transcribed the way the extractor writes it. */
  const JUN_FU = letter({
    letter_date: "2026-06-23",
    follow_ups: [promise("FU", "4 weeks")],
  });

  it("turns a promise with no step of its own into a step that can run late", () => {
    const graph = buildGraph([JUN_FU], "2026-07-25");

    const followUp = graph.nodes.find((node) => /follow.?up/i.test(node.label))!;
    expect(followUp.dueDate).toBe("2026-07-21");
    expect(followUp.overdue?.daysOverdue).toBe(4);
  });

  it("does not hand the next appointment's promise to the one booked for today", () => {
    // The 20-May letter books a follow-up FOR 23 Jun; the 23-Jun letter IS that
    // appointment, and it promises another in four weeks. The June promise used
    // to resolve onto the June appointment and lose to its earlier due date, so
    // the graph said nothing was late when the only late thing on the pathway
    // was this. Nothing has written the June clinic up as attended, so it is
    // still an open step — being spent is about its day having come, not about
    // its status.
    const graph = buildGraph([
      letter({
        letter_date: "2026-05-20",
        follow_ups: [promise("follow up in IRIS clinic", "23/06/2026", "2026-06-23")],
      }),
      letter({ letter_date: "2026-06-23", follow_ups: [promise("FU", "4 weeks")] }),
    ], "2026-07-25");

    const booked = graph.nodes.find((node) => /IRIS/i.test(node.label))!;
    expect(booked.dueDate).toBe("2026-06-23");

    const promised = graph.nodes.find((node) => node.id !== booked.id && /follow.?up/i.test(node.label));
    expect(promised?.dueDate).toBe("2026-07-21");
    expect(promised?.overdue?.daysOverdue).toBe(4);
  });

  it("does not let an appointment already attended keep the promise of the next one", () => {
    // Same two letters, with the June clinic written up as attended on the day.
    // A finished step can only be what kept a promise made after it happened.
    const graph = buildGraph([
      letter({
        letter_date: "2026-05-20",
        follow_ups: [promise("follow up in IRIS clinic", "23/06/2026", "2026-06-23")],
      }),
      letter({
        letter_date: "2026-06-23",
        investigations: [{
          id: "iris",
          name: "follow up in IRIS clinic",
          type: "consult",
          status: "actioned",
          ordered_date: null,
          report_date: "2026-06-23",
        }],
        follow_ups: [promise("FU", "4 weeks")],
      }),
    ], "2026-07-25");

    const attended = graph.nodes.find((node) => /IRIS/i.test(node.label))!;
    expect(attended.status).toBe("actioned");
    expect(attended.overdue).toBeNull();

    const promised = graph.nodes.find((node) => node.id !== attended.id && /follow.?up/i.test(node.label));
    expect(promised?.dueDate).toBe("2026-07-21");
    expect(promised?.overdue?.daysOverdue).toBe(4);
  });

  it("treats a promise as kept by the step that followed it", () => {
    // "Chest x-ray next week" on 2 March, reported on 13 March. The x-ray
    // happened AFTER the letter asked for it, so nothing is outstanding and no
    // second x-ray is invented.
    const graph = buildGraph([
      letter({
        letter_date: "2026-03-02",
        department: "Gastroenterology",
        follow_ups: [promise("chest x-ray", "next week")],
      }),
      letter({
        letter_date: "2026-05-01",
        investigations: [{
          id: "cxr",
          name: "chest x-ray",
          type: "xray",
          status: "reported",
          ordered_date: null,
          report_date: "2026-03-13",
        }],
      }),
    ], "2026-07-25");

    const xrays = graph.nodes.filter((node) => /x.?ray/i.test(node.label));
    expect(xrays).toHaveLength(1);
    expect(xrays[0].status).toBe("reported");
    expect(xrays[0].dueDate).toBeNull();
    expect(graph.nodes.every((node) => !node.overdue)).toBe(true);
  });
});
