/** Deterministic cross-department graph construction and stall detection. */

import type {
  EdgeKind,
  Extraction,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  PathwayGraph,
  Stall,
} from "./types";
import { daysBetween, EXPECTED_MAX_DAYS, todayISO } from "./stateMachine";

const TERMINAL_ID = "approval:jak-inhibitor-approval";
const COMPLETED = new Set(["done", "reported", "actioned"]);

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^(the|a)$/, "");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function dateOrNull(value: string | null | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
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

function addEdge(edges: GraphEdge[], from: GraphNode | undefined, to: GraphNode | undefined, kind: EdgeKind) {
  if (!from || !to || from.id === to.id) return;
  if (!edges.some((edge) => edge.from === from.id && edge.to === to.id && edge.kind === kind)) {
    edges.push({ from: from.id, to: to.id, kind });
  }
}

function investigationMatches(a: GraphNode, b: {
  name: string;
  invType: GraphNode["invType"];
  ordered_date: string | null;
  report_date: string | null;
}): boolean {
  if (a.kind !== "investigation" || a.invType !== b.invType || compact(a.label) !== compact(b.name)) return false;
  // A repeated test is a new node unless one of its written dates overlaps.
  return Boolean(
    (a.ordered_date && (a.ordered_date === b.ordered_date || a.ordered_date === b.report_date)) ||
      (a.report_date && (a.report_date === b.ordered_date || a.report_date === b.report_date)),
  );
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

/** Build a graph from independent, per-letter extractions. */
export function buildGraph(extractions: Extraction[]): PathwayGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const sourceFindings: Array<{ node: GraphNode; on: string | null; spawned: string | null }> = [];
  const sourceDependencies: Extraction["dependencies"] = [];
  const sourceMdts: Array<{ extraction: Extraction; date: string | null; outcome: string | null; awaiting: string | null }> = [];

  for (const extraction of extractions) {
    for (const investigation of extraction.investigations) {
      const existing = nodes.find((node) => investigationMatches(node, {
        name: investigation.name,
        invType: investigation.type,
        ordered_date: investigation.ordered_date,
        report_date: investigation.report_date,
      }));
      if (existing) {
        if (!existing.report_date && investigation.report_date) existing.report_date = investigation.report_date;
        if (COMPLETED.has(investigation.status)) existing.status = investigation.status;
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
      sourceMdts.push({ extraction, date: mdt.date, outcome: mdt.outcome, awaiting: mdt.awaiting });
    }
    sourceDependencies.push(...extraction.dependencies);
  }

  // The terminal goal is explicit and always present, even if no approval
  // letter has been uploaded yet.
  const gastro = extractions.find((item) => /gastro/i.test(item.department || ""));
  const terminal = makeNode({
    id: TERMINAL_ID,
    label: "Jak inhibitor approval",
    dept: gastro?.department || "Gastroenterology",
    kind: "approval",
    status: "awaiting",
  });
  nodes.push(terminal);

  // A finding is attached to the investigation on which it was reported and
  // points to the investigation it spawned. Both edges are factual joins.
  for (const finding of sourceFindings) {
    addEdge(edges, findNode(nodes, finding.on), finding.node, "spawned_by");
    addEdge(edges, finding.node, findNode(nodes, finding.spawned), "spawned_by");
  }

  // Explicit “awaiting X before Y” relationships are the only source of
  // cross-letter dependency edges; the LLM does not invent these joins.
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

  return { nodes, edges };
}

function startDate(node: GraphNode): string | null {
  return node.ordered_date || node.report_date;
}

function outgoing(graph: PathwayGraph, id: string): GraphEdge[] {
  return graph.edges.filter((edge) => edge.from === id);
}

function pathToTerminal(graph: PathwayGraph, start: GraphNode): GraphNode[] | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const queue: Array<{ id: string; path: GraphNode[] }> = [{ id: start.id, path: [start] }];
  const seen = new Set([start.id]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.id === TERMINAL_ID) return current.path;
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

/** Find the first upstream overdue bottleneck on a path to the approval goal. */
export function findStall(graph: PathwayGraph, asOf = todayISO()): Stall | null {
  const candidates = graph.nodes.filter((node) => {
    const since = startDate(node);
    return (
      node.id !== TERMINAL_ID &&
      !COMPLETED.has(node.status) &&
      node.expected_days !== null &&
      since !== null &&
      daysBetween(since, asOf) > node.expected_days &&
      pathToTerminal(graph, node) !== null
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
  const chain = pathToTerminal(graph, root) || [root];
  return {
    stalledNode: root,
    chain,
    owningDept: root.dept,
    sinceDate,
    daysStalled: sinceDate ? daysBetween(sinceDate, asOf) : 0,
    expectedDays: root.expected_days,
  };
}

export { TERMINAL_ID };
