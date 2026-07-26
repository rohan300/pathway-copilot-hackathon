/** Pure, client-safe helpers for the Critical Path UI and dormant vitals chart. */

import type {
  Extraction,
  GraphNode,
  NoStallReason,
  PathwayGoal,
  PathwayGraph,
  Stall,
  VitalMetric,
} from "@/lib/pipeline/types";

/** Earliest written date across the letters — the pathway start for vitals. */
export function pathwayStartDate(docs: Extraction[]): string | null {
  const dated = docs.map((doc) => doc.letter_date).filter((date): date is string => Boolean(date));
  return dated.length ? [...dated].sort()[0] : null;
}

/** e.g. "2026-05-27" -> "27 May 2026". Returns "—" for null/invalid. */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Pathway shaping — what the chain is, where it currently sits, what is noise.
// ---------------------------------------------------------------------------

/** Statuses that mean a step is finished rather than outstanding. */
const SETTLED = new Set(["reported", "done", "actioned"]);

export function isSettled(node: GraphNode): boolean {
  return SETTLED.has(node.status);
}

export interface PathwayView {
  /** Ordered referral → clinic → investigations → goal. */
  chain: GraphNode[];
  /** Everything mentioned in the letters that is not on the path to the goal. */
  others: GraphNode[];
  goal: PathwayGoal | null;
  /** Where the pathway currently sits — the stalled step, or the first open one. */
  current: GraphNode | null;
}

/**
 * Turn a graph into the shape the panel renders.
 *
 * `goal` and `chainIds` are required on PathwayGraph and computed by
 * lib/pipeline/graph.ts, so the chain is read straight off the API rather than
 * re-derived here — the backend is the single source of truth for what is on
 * the path to the goal.
 */
export function buildPathwayView(graph: PathwayGraph | null, stall: Stall | null): PathwayView {
  if (!graph) return { chain: [], others: [], goal: null, current: null };
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  const chain = graph.chainIds
    .map((id) => byId.get(id))
    .filter((node): node is GraphNode => Boolean(node));

  // The stall's own chain runs from the stalled node down to the goal, so
  // anything it names that chainIds missed is appended rather than dropped.
  const seen = new Set(chain.map((node) => node.id));
  for (const node of stall?.chain ?? []) {
    if (!seen.has(node.id)) {
      chain.push(byId.get(node.id) ?? node);
      seen.add(node.id);
    }
  }

  const current =
    (stall && (byId.get(stall.stalledNode.id) ?? stall.stalledNode)) ??
    chain.find((node) => !isSettled(node)) ??
    chain[chain.length - 1] ??
    null;

  const others = graph.nodes
    .filter((node) => !seen.has(node.id))
    .sort((a, b) => (nodeDate(a) ?? "").localeCompare(nodeDate(b) ?? ""));

  return { chain, others, goal: graph.goal, current };
}

function nodeDate(node: GraphNode): string | null {
  return node.report_date ?? node.ordered_date;
}

// ---------------------------------------------------------------------------
// Timeline — the chain laid out against a real time axis (GLD-17).
// ---------------------------------------------------------------------------

/**
 * The one place a node's position on the rail is decided.
 *
 * A node sits at the date it actually happened, falling back to when it was
 * requested. GLD-16 adds an authoritative `timelineDate` to GraphNode; when
 * that lands this function reads it and the fallback below goes away. Nothing
 * else in the UI picks a date for itself.
 */
function railDate(node: GraphNode): string | null {
  return nodeDate(node);
}

/** True for an ISO date the browser can actually parse. Guards AC6 — a junk
    date must degrade to "no date recorded", never render "Invalid Date". */
function isDate(iso: string | null): iso is string {
  return Boolean(iso) && !Number.isNaN(new Date(`${iso}T00:00:00`).getTime());
}

function daysApart(from: string, to: string): number | null {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** A duration in the words the letters themselves use — "5 weeks", not "34 days". */
export function describeSpan(days: number): string {
  const n = Math.abs(days);
  if (n < 14) return `${n} day${n === 1 ? "" : "s"}`;
  if (n < 60) return `${Math.round(n / 7)} weeks`;
  const months = Math.round(n / 30.44);
  return `${months} month${months === 1 ? "" : "s"}`;
}

/** e.g. "2026-03-13" -> "13 Mar". Gutter labels stay narrow. */
export function formatDayMonth(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * How overdue a step is, in plain words. Built from the step's own `overdue`
 * where the API set one, and from the single `Stall` otherwise — the bottleneck
 * is still marked when the letters promised no date for it and it is late only
 * against a typical wait. Deliberately reports only what the API computed: no
 * due date, day count or lateness is ever derived client-side.
 */
export interface TimelineOverdue {
  /** Plain-words headline, e.g. "waiting 5 months". */
  phrase: string;
  /** Supporting clause, e.g. "expected within 28 days". Null when undefined. */
  detail: string | null;
}

export interface TimelineEntry {
  node: GraphNode;
  /** Where it sits on the rail. Null for a step the letters never dated. */
  date: string | null;
  isGoal: boolean;
  settled: boolean;
  overdue: TimelineOverdue | null;
  /**
   * Request-to-report turnaround, when both dates are known and it's long
   * enough to be worth naming. This is AC7's secondary delay — read off the two
   * dates the node already carries, never flagged as the bottleneck.
   */
  turnaroundDays: number | null;
}

export interface TimelineMonth {
  /** "2026-03" */
  key: string;
  /** "March 2026" */
  label: string;
  entries: TimelineEntry[];
}

export interface TimelineView {
  /**
   * Every month from the first dated step to the last — including months with
   * nothing in them, so a five-week gap is visible as a gap rather than
   * collapsing into the next card.
   */
  months: TimelineMonth[];
  /** Dated steps, oldest first — the flat rail, for callers that don't want months. */
  dated: TimelineEntry[];
  /** Chain steps the letters never dated. Shown after the rail, never dropped. */
  undated: TimelineEntry[];
  /** The goal when it has no date of its own — the rail's destination marker. */
  destination: TimelineEntry | null;
}

/** Past this many months the empty-month axis is more noise than signal. */
const MAX_AXIS_MONTHS = 18;

/** Three weeks — the point at which a turnaround is worth calling out. */
const NOTABLE_TURNAROUND_DAYS = 21;

/**
 * Lay the pathway chain out chronologically (GLD-17 AC1).
 *
 * Off-chain nodes are not included — they stay demoted in their own group per
 * GLD-13 AC4 / GLD-17 AC5. The goal is pulled out as a destination when it has
 * no date, so an unstarted treatment reads as the end of the road rather than
 * as a step with missing data.
 */
export function buildTimeline(view: PathwayView, stall: Stall | null): TimelineView {
  const entries: TimelineEntry[] = view.chain.map((node) => {
    const date = railDate(node);
    const isStalled = node.id === stall?.stalledNode.id;
    const turnaround =
      node.ordered_date && node.report_date ? daysApart(node.ordered_date, node.report_date) : null;
    return {
      node,
      date: isDate(date) ? date : null,
      isGoal: node.id === view.goal?.nodeId,
      settled: isSettled(node),
      overdue: overdueFromNode(node) ?? (isStalled && stall ? overdueFromStall(stall) : null),
      turnaroundDays:
        turnaround !== null && turnaround >= NOTABLE_TURNAROUND_DAYS ? turnaround : null,
    };
  });

  // The goal only becomes the destination marker when it is both undated and
  // unfinished — a goal that already happened belongs on the rail at its date.
  const destinationIndex = entries.findIndex((e) => e.isGoal && !e.date && !e.settled);
  const destination = destinationIndex >= 0 ? entries[destinationIndex] : null;
  const rest = entries.filter((_, i) => i !== destinationIndex);

  const dated = rest
    .filter((e): e is TimelineEntry & { date: string } => e.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const undated = rest.filter((e) => e.date === null);

  return { months: groupByMonth(dated), dated, undated, destination };
}

/** Every entry in the order the rail renders it — dated, then undated, then the goal. */
export function timelineOrder(timeline: TimelineView): TimelineEntry[] {
  return [...timeline.dated, ...timeline.undated, ...(timeline.destination ? [timeline.destination] : [])];
}

/** "12 Jan – 23 Jun 2026 · 5 months" — the whole arc in one line (AC1). */
export function timelineSpanLabel(timeline: TimelineView): string | null {
  if (timeline.dated.length === 0) return null;
  const first = timeline.dated[0].date as string;
  const last = timeline.dated[timeline.dated.length - 1].date as string;
  const range = `${formatDayMonth(first)} – ${formatDate(last)}`;
  const days = daysApart(first, last);
  return days !== null && days >= 14 ? `${range} · ${describeSpan(days)}` : range;
}

/**
 * A step against the date the letters actually promised for it (GLD-17 AC2):
 * "due 21 Jul · 4 days overdue", with the clinic's own words underneath.
 *
 * Every number here is read straight off the node — `daysOverdue` is what the
 * API worked out, and `basis` is the sentence it wrote to explain the date, so
 * the rail quotes the letters rather than paraphrasing them. A step the letters
 * never promised a date for carries no `overdue` at all and is not called late.
 */
function overdueFromNode(node: GraphNode): TimelineOverdue | null {
  if (!node.overdue) return null;
  const late = `${describeSpan(node.overdue.daysOverdue)} overdue`;
  return {
    phrase: node.dueDate && isDate(node.dueDate) ? `due ${formatDayMonth(node.dueDate)} · ${late}` : late,
    detail: node.overdue.basis || null,
  };
}

function overdueFromStall(stall: Stall): TimelineOverdue {
  return {
    phrase: `waiting ${describeSpan(stall.daysStalled)}`,
    detail: stall.expectedDays === null ? null : `expected within ${stall.expectedDays} days`,
  };
}

function groupByMonth(dated: TimelineEntry[]): TimelineMonth[] {
  if (dated.length === 0) return [];
  const byKey = new Map<string, TimelineEntry[]>();
  for (const entry of dated) {
    const key = (entry.date as string).slice(0, 7);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(entry);
    else byKey.set(key, [entry]);
  }

  const keys = axisKeys(
    (dated[0].date as string).slice(0, 7),
    (dated[dated.length - 1].date as string).slice(0, 7),
    byKey,
  );
  return keys.map((key) => ({ key, label: monthLabel(key), entries: byKey.get(key) ?? [] }));
}

/**
 * Every month across the span, so quiet months render as visible gaps. Over
 * MAX_AXIS_MONTHS the run of empty rows stops being informative, so only
 * months that actually contain something are kept.
 */
function axisKeys(first: string, last: string, byKey: Map<string, unknown>): string[] {
  const occupied = [...byKey.keys()].sort();
  let [year, month] = first.split("-").map(Number);
  const [lastYear, lastMonth] = last.split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(lastYear)) return occupied;

  const keys: string[] = [];
  while ((year < lastYear || (year === lastYear && month <= lastMonth)) && keys.length < MAX_AXIS_MONTHS) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  // Ran past the cap — the span is too long for a full axis.
  return keys.length >= MAX_AXIS_MONTHS ? occupied : keys;
}

function monthLabel(key: string): string {
  const d = new Date(`${key}-01T00:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

/**
 * Headline for the no-stall panel — never a bare node count. Codes are the
 * ones lib/pipeline/graph.ts `explainNoStall` actually emits; the reason's own
 * `message` carries the detail underneath.
 */
export function noStallHeadline(reason: NoStallReason | null): string {
  switch (reason?.code) {
    case "no_dated_nodes":
      return "No dated steps to time";
    case "no_path_to_goal":
      return "Nothing open connects to your goal";
    case "nothing_overdue":
      return "Nothing is past its expected window yet";
    default:
      return "No overdue step found";
  }
}

/** Fallback copy when the API hasn't sent a reason (older server, or an older cached response). */
export const NO_STALL_FALLBACK =
  "Every open step in these letters is still inside the window we'd expect it to take. Nothing here needs chasing today.";

// ---------------------------------------------------------------------------
// Vitals — retained as an orthogonal, client-side chart helper.
// ---------------------------------------------------------------------------

export interface CsvPoint {
  date: string;
  resting_hr: number;
  sleep_minutes: number;
  hrv: number;
  steps: number;
}

const HEADER_ALIASES: Record<string, keyof CsvPoint | "date"> = {
  date: "date",
  day: "date",
  resting_hr: "resting_hr",
  "resting hr": "resting_hr",
  resting_heart_rate: "resting_hr",
  rhr: "resting_hr",
  sleep_minutes: "sleep_minutes",
  "sleep minutes": "sleep_minutes",
  sleep_min: "sleep_minutes",
  sleep: "sleep_minutes",
  hrv: "hrv",
  steps: "steps",
};

/** Parse a Fitbit CSV into date-sorted daily points for charting. */
export function parseCsvSeries(csv: string): CsvPoint[] {
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((cell) => cell.trim().toLowerCase());
  const col: Partial<Record<keyof CsvPoint, number>> = {};
  header.forEach((cell, index) => {
    const key = HEADER_ALIASES[cell];
    if (key && col[key] === undefined) col[key] = index;
  });
  if (col.date === undefined) return [];

  const points: CsvPoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const date = cells[col.date]?.trim();
    if (!date) continue;
    const num = (key: keyof CsvPoint): number => {
      const value = col[key] === undefined ? NaN : Number(cells[col[key] as number]);
      return Number.isFinite(value) ? value : 0;
    };
    points.push({ date, resting_hr: num("resting_hr"), sleep_minutes: num("sleep_minutes"), hrv: num("hrv"), steps: num("steps") });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

export const METRIC_META: Record<
  VitalMetric,
  { label: string; short: string; unit: string; riseIsAdverse: boolean; format: (n: number) => string }
> = {
  resting_hr: { label: "Resting heart rate", short: "Resting HR", unit: "bpm", riseIsAdverse: true, format: (n) => `${Math.round(n)}` },
  hrv: { label: "Heart-rate variability", short: "HRV", unit: "ms", riseIsAdverse: false, format: (n) => `${Math.round(n)}` },
  sleep_minutes: {
    label: "Sleep", short: "Sleep", unit: "", riseIsAdverse: false,
    format: (n) => `${Math.floor(n / 60)}h ${Math.round(n % 60)}m`,
  },
  steps: { label: "Daily steps", short: "Steps", unit: "", riseIsAdverse: false, format: (n) => Math.round(n).toLocaleString("en-GB") },
};

export const METRIC_ORDER: VitalMetric[] = ["resting_hr", "hrv", "sleep_minutes", "steps"];
