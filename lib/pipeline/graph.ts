/** Deterministic cross-department graph construction and stall detection. */

import type {
  EdgeKind,
  Extraction,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  NoStallReason,
  PathwayGoal,
  PathwayGraph,
  Stall,
} from "./types";
import { daysBetween, EXPECTED_MAX_DAYS, todayISO } from "./stateMachine";

const COMPLETED = new Set(["done", "reported", "actioned"]);
/** Most advanced status wins when the same step appears in several letters. */
const STATUS_RANK: Record<string, number> = {
  unknown: 0,
  ordered: 1,
  booked: 2,
  done: 3,
  reported: 4,
  actioned: 5,
};
const FALLBACK_GOAL_LABEL = "Treatment decision";

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^(the|a)$/, "");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function sentenceCase(value: string): string {
  const text = value.trim().replace(/\s+/g, " ");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function dateOrNull(value: string | null | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function rank(status: string): number {
  return STATUS_RANK[status] ?? 0;
}

function expectedDays(kind: GraphNodeKind, invType: GraphNode["invType"]): number | null {
  const value = EXPECTED_MAX_DAYS[invType || kind];
  return typeof value === "number" ? value : null;
}

function makeNode(input: {
  id: string;
  label: string;
  dept: string | null;
  kind: GraphNodeKind;
  invType?: GraphNode["invType"];
  status: string;
  ordered_date?: string | null;
  report_date?: string | null;
}): GraphNode {
  const invType = input.invType ?? null;
  return {
    id: input.id,
    label: input.label,
    dept: input.dept,
    kind: input.kind,
    invType,
    status: input.status,
    ordered_date: dateOrNull(input.ordered_date),
    report_date: dateOrNull(input.report_date),
    expected_days: expectedDays(input.kind, invType),
  };
}

function addEdge(
  edges: GraphEdge[],
  from: GraphNode | undefined,
  to: GraphNode | undefined,
  kind: EdgeKind,
  inferred = false,
) {
  if (!from || !to || from.id === to.id) return;
  if (!edges.some((edge) => edge.from === from.id && edge.to === to.id && edge.kind === kind)) {
    edges.push(inferred ? { from: from.id, to: to.id, kind, inferred: true } : { from: from.id, to: to.id, kind });
  }
}

/**
 * The same test written up in two letters is one step. Matching is on the
 * normalized name and type only — requiring a written date overlap meant every
 * undated repeat became its own node (33 nodes from 3 letters).
 */
function investigationMatches(a: GraphNode, b: { name: string; invType: GraphNode["invType"] }): boolean {
  return a.kind === "investigation" && a.invType === b.invType && compact(a.label) === compact(b.name);
}

function findNode(nodes: GraphNode[], text: string | null | undefined): GraphNode | undefined {
  if (!text) return undefined;
  const wanted = compact(text);
  if (!wanted) return undefined;
  return nodes.find((node) => compact(node.label) === wanted) ?? nodes.find((node) => {
    const label = compact(node.label);
    return label.includes(wanted) || wanted.includes(label);
  });
}

/** Letters sorted oldest-first; undated letters keep their upload order at the front. */
function byLetterDate(extractions: Extraction[]): Extraction[] {
  return extractions
    .map((extraction, index) => ({ extraction, index }))
    .sort((a, b) => {
      const left = a.extraction.letter_date || "";
      const right = b.extraction.letter_date || "";
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map((item) => item.extraction);
}

/**
 * The goal is whatever the LETTERS are working toward — never a hardcoded
 * label. Preference order: what the latest letter states outright, then what
 * the stated dependencies terminate in, then treatment wording in the prose,
 * then a generic placeholder. The model only ever supplies the NAME.
 */
function inferGoal(ordered: Extraction[]): { label: string; dept: string | null; source: PathwayGoal["source"] } {
  const latestFirst = [...ordered].reverse();

  for (const extraction of latestFirst) {
    const stated = extraction.stated_goal?.trim();
    if (stated) return { label: sentenceCase(stated), dept: extraction.department, source: "stated" };
  }

  // A dependency chain terminates in the thing nothing else blocks: that is the
  // goal the letters describe, in the letters' own words.
  const blocking = new Set(
    ordered.flatMap((extraction) => extraction.dependencies.map((item) => compact(item.blocking_item))),
  );
  for (const extraction of latestFirst) {
    for (const dependency of [...extraction.dependencies].reverse()) {
      if (!blocking.has(compact(dependency.blocked_item))) {
        const gastro = ordered.find((item) => /gastro/i.test(item.department || ""));
        return {
          label: sentenceCase(dependency.blocked_item),
          dept: gastro?.department || extraction.department,
          source: "derived",
        };
      }
    }
  }

  // Treatment intent written as prose: "start filgotinib", "commence infliximab".
  for (const extraction of latestFirst) {
    const prose = [
      ...extraction.findings.map((finding) => finding.text),
      ...extraction.mdt.flatMap((mdt) => [mdt.outcome, mdt.awaiting]),
      ...extraction.referrals.map((referral) => referral.reason),
    ].filter((text): text is string => Boolean(text));
    for (const text of prose) {
      const started = text.match(/\b(?:start|commence|initiate|begin)\s+(?:on\s+)?([A-Za-z][A-Za-z0-9-]{3,})/i);
      if (started) return { label: `Start ${started[1].toLowerCase()}`, dept: extraction.department, source: "derived" };
      const therapy = text.match(/\b(advanced medical therapy|biologic therapy|biological therapy)\b/i);
      if (therapy) return { label: `Start ${therapy[1].toLowerCase()}`, dept: extraction.department, source: "derived" };
    }
  }

  const latest = latestFirst[0];
  return { label: FALLBACK_GOAL_LABEL, dept: latest?.department ?? null, source: "fallback" };
}

/** The date a step is timed from. */
function startDate(node: GraphNode): string | null {
  return node.ordered_date || node.report_date;
}

function outgoing(graph: PathwayGraph, id: string): GraphEdge[] {
  return graph.edges.filter((edge) => edge.from === id);
}

function pathToGoal(graph: PathwayGraph, start: GraphNode): GraphNode[] | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const queue: Array<{ id: string; path: GraphNode[] }> = [{ id: start.id, path: [start] }];
  const seen = new Set([start.id]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.id === graph.goal.nodeId) return current.path;
    for (const edge of outgoing(graph, current.id)) {
      if (seen.has(edge.to)) continue;
      const next = byId.get(edge.to);
      if (!next) continue;
      seen.add(next.id);
      queue.push({ id: next.id, path: [...current.path, next] });
    }
  }
  return null;
}

/** Build a graph from independent, per-letter extractions. */
export function buildGraph(extractions: Extraction[]): PathwayGraph {
  const ordered = byLetterDate(extractions);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const sourceFindings: Array<{ node: GraphNode; on: string | null; spawned: string | null }> = [];
  const sourceDependencies: Extraction["dependencies"] = [];
  const sourceMdts: Array<{ date: string | null; outcome: string | null; awaiting: string | null }> = [];
  /** Every node a given letter contributed, for the date-ordered fallback. */
  const dependencyText = new Set(
    ordered.flatMap((extraction) =>
      extraction.dependencies.flatMap((item) => [compact(item.blocked_item), compact(item.blocking_item)]),
    ),
  );

  for (const extraction of ordered) {
    for (const investigation of extraction.investigations) {
      const existing = nodes.find((node) =>
        investigationMatches(node, { name: investigation.name, invType: investigation.type }),
      );
      if (existing) {
        // Union the dates and keep the most advanced status seen anywhere.
        if (!existing.ordered_date) existing.ordered_date = dateOrNull(investigation.ordered_date);
        if (!existing.report_date) existing.report_date = dateOrNull(investigation.report_date);
        if (rank(investigation.status) > rank(existing.status)) existing.status = investigation.status;
        continue;
      }
      nodes.push(makeNode({
        id: `investigation:${slug(investigation.name)}-${nodes.length + 1}`,
        label: investigation.name,
        dept: extraction.department,
        kind: "investigation",
        invType: investigation.type,
        status: investigation.status,
        ordered_date: investigation.ordered_date,
        report_date: investigation.report_date,
      }));
    }

    for (const finding of extraction.findings) {
      // Background prose is not a pathway step. A finding earns a node only if
      // it joins two steps or the letters name it in a dependency.
      const connective = Boolean(finding.on_investigation || finding.spawned) ||
        dependencyText.has(compact(finding.text));
      if (!connective) continue;
      const existing = nodes.find((node) => node.kind === "finding" && compact(node.label) === compact(finding.text));
      if (existing) {
        sourceFindings.push({ node: existing, on: finding.on_investigation, spawned: finding.spawned });
        continue;
      }
      const node = makeNode({
        id: `finding:${slug(finding.text)}-${nodes.length + 1}`,
        label: finding.text,
        dept: extraction.department,
        kind: "finding",
        status: "reported",
        ordered_date: extraction.letter_date,
      });
      nodes.push(node);
      sourceFindings.push({ node, on: finding.on_investigation, spawned: finding.spawned });
    }

    for (const referral of extraction.referrals) {
      const label = /clearance/i.test(referral.reason || "")
        ? `${referral.to_dept || "Department"} clearance`
        : referral.reason || `${referral.to_dept || "Department"} referral`;
      const existing = nodes.find((node) => node.kind === "referral" && compact(node.label) === compact(label));
      if (!existing) {
        nodes.push(makeNode({
          id: `referral:${slug(label)}`,
          label,
          dept: referral.to_dept,
          kind: "referral",
          status: "ordered",
          ordered_date: referral.date || extraction.letter_date,
        }));
      }
    }

    for (const mdt of extraction.mdt) {
      sourceMdts.push({ date: mdt.date, outcome: mdt.outcome, awaiting: mdt.awaiting });
    }
    sourceDependencies.push(...extraction.dependencies);
  }

  // A referral is answered once the department it points at writes a later
  // letter — otherwise every historic referral stays "ordered" forever and
  // reports as the oldest bottleneck long after the clinic actually happened.
  for (const node of nodes) {
    if (node.kind !== "referral" || !node.dept) continue;
    // A referral a letter explicitly says something is awaiting stays open
    // until a letter says otherwise — the words beat the inference.
    const label = compact(node.label);
    if ([...dependencyText].some((text) => text.includes(label) || label.includes(text))) continue;
    const sent = startDate(node);
    const answered = ordered.some((extraction) => {
      const dept = compact(extraction.department || "");
      const target = compact(node.dept!);
      if (!dept || !target || !(dept.includes(target) || target.includes(dept))) return false;
      return Boolean(extraction.letter_date && sent && extraction.letter_date >= sent);
    });
    if (answered) node.status = "actioned";
  }

  // The goal is derived from the letters; reuse a node that already carries the
  // same label rather than appending a duplicate terminal.
  const inferred = inferGoal(ordered);
  const existingGoal = nodes.find((node) => compact(node.label) === compact(inferred.label));
  const goalNode = existingGoal ?? makeNode({
    id: `approval:${slug(inferred.label)}`,
    label: inferred.label,
    dept: inferred.dept,
    kind: "approval",
    status: "awaiting",
  });
  if (!existingGoal) nodes.push(goalNode);
  const goal: PathwayGoal = {
    nodeId: goalNode.id,
    label: goalNode.label,
    dept: goalNode.dept,
    source: inferred.source,
  };

  // A finding is attached to the investigation on which it was reported and
  // points to the investigation it spawned. Both edges are factual joins.
  for (const finding of sourceFindings) {
    addEdge(edges, findNode(nodes, finding.on), finding.node, "spawned_by");
    addEdge(edges, finding.node, findNode(nodes, finding.spawned), "spawned_by");
  }

  // Explicit “awaiting X before Y” relationships are stated dependency edges;
  // the LLM does not invent these joins.
  for (const dependency of sourceDependencies) {
    const blocked = findNode(nodes, dependency.blocked_item);
    const blocking = findNode(nodes, dependency.blocking_item);
    const kind: EdgeKind = /await/i.test(dependency.stated_status || "") ? "awaiting" : "blocks";
    addEdge(edges, blocking, blocked, kind);
  }

  // MDT awaiting fields are also explicit joins when present. Reuse an
  // existing node instead of creating a duplicate clearance node.
  for (const mdt of sourceMdts) {
    const awaiting = findNode(nodes, mdt.awaiting);
    const outcome = findNode(nodes, mdt.outcome);
    if (awaiting && outcome) addEdge(edges, awaiting, outcome, "awaiting");
  }

  const graph: PathwayGraph = { nodes, edges, goal, chainIds: [] };
  connectFallbackChain(graph);
  graph.chainIds = chainIds(graph);
  return graph;
}

/**
 * Real letters rarely write "awaiting X before Y", so stated dependencies alone
 * leave a heap of unconnected nodes and nothing can reach the goal. When that
 * happens — and only then — connect the dated steps in date order, so referral
 * -> clinic -> investigation -> goal forms one chain. Deterministic: the order
 * comes from the written dates, never from the model.
 */
function connectFallbackChain(graph: PathwayGraph) {
  const alreadyConnected = graph.nodes.some(
    (node) => node.id !== graph.goal.nodeId && pathToGoal(graph, node) !== null,
  );
  if (alreadyConnected) return;

  const spine = graph.nodes
    .filter((node) => node.id !== graph.goal.nodeId && node.kind !== "finding" && startDate(node) !== null)
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const left = startDate(a.node)!;
      const right = startDate(b.node)!;
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map((item) => item.node);
  if (!spine.length) return;

  for (let i = 0; i < spine.length - 1; i++) {
    addEdge(graph.edges, spine[i], spine[i + 1], "blocks", true);
  }
  addEdge(graph.edges, spine[spine.length - 1], graph.nodes.find((node) => node.id === graph.goal.nodeId), "blocks", true);
}

/** Nodes that actually reach the goal, in date order, ending at the goal. */
function chainIds(graph: PathwayGraph): string[] {
  const onChain = graph.nodes
    .filter((node) => node.id !== graph.goal.nodeId && pathToGoal(graph, node) !== null)
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const left = startDate(a.node) || "9999-12-31";
      const right = startDate(b.node) || "9999-12-31";
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map((item) => item.node.id);
  return [...onChain, graph.goal.nodeId];
}

/** Find the first upstream overdue bottleneck on a path to the goal. */
export function findStall(graph: PathwayGraph, asOf = todayISO()): Stall | null {
  const candidates = graph.nodes.filter((node) => {
    const since = startDate(node);
    return (
      node.id !== graph.goal.nodeId &&
      !COMPLETED.has(node.status) &&
      node.expected_days !== null &&
      since !== null &&
      daysBetween(since, asOf) > node.expected_days &&
      pathToGoal(graph, node) !== null
    );
  });
  if (!candidates.length) return null;

  // If an overdue node is itself downstream of another overdue candidate,
  // report the upstream root: that is the actionable bottleneck to chase.
  const candidateIds = new Set(candidates.map((node) => node.id));
  const downstreamOfCandidate = new Set<string>();
  for (const edge of graph.edges) {
    if (!candidateIds.has(edge.from)) continue;
    const queue = [edge.to];
    while (queue.length) {
      const id = queue.shift()!;
      if (downstreamOfCandidate.has(id)) continue;
      downstreamOfCandidate.add(id);
      for (const next of graph.edges.filter((item) => item.from === id)) queue.push(next.to);
    }
  }
  const root = candidates.find((node) => !downstreamOfCandidate.has(node.id)) || candidates[0];
  const sinceDate = startDate(root);
  const chain = pathToGoal(graph, root) || [root];
  return {
    stalledNode: root,
    chain,
    owningDept: root.dept,
    sinceDate,
    daysStalled: sinceDate ? daysBetween(sinceDate, asOf) : 0,
    expectedDays: root.expected_days,
  };
}

/**
 * Why findStall returned null. "No bottleneck" and "we could not compute one"
 * look identical to a user otherwise — this says which it was.
 */
export function explainNoStall(graph: PathwayGraph, asOf = todayISO()): NoStallReason {
  void asOf;
  const steps = graph.nodes.filter((node) => node.id !== graph.goal.nodeId);
  if (!steps.some((node) => startDate(node) !== null)) {
    return {
      code: "no_dated_nodes",
      message: "No letter gives a date for any step, so nothing can be timed against its expected wait.",
    };
  }
  const open = steps.filter((node) => !COMPLETED.has(node.status));
  if (!open.length) {
    return {
      code: "nothing_overdue",
      message: "Every step the letters name is complete — nothing is outstanding.",
    };
  }
  if (!open.some((node) => pathToGoal(graph, node) !== null)) {
    return {
      code: "no_path_to_goal",
      message: `No open step connects to the goal (${graph.goal.label}), so nothing can be shown as blocking it.`,
    };
  }
  return {
    code: "nothing_overdue",
    message: "Every open step is still inside its expected window — nothing is past its expected wait.",
  };
}
