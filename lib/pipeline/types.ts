/** Shared contracts for the Critical Path pipeline. */

// ---------------------------------------------------------------------------
// Per-letter extraction (LLM reads one document; it never reasons across docs)
// ---------------------------------------------------------------------------

export type InvestigationType =
  | "ct"
  | "mri"
  | "bronchoscopy"
  | "consult"
  | "bloods"
  | "xray"
  | "other";

export type InvestigationStatus =
  | "ordered"
  | "booked"
  | "done"
  | "reported"
  | "actioned"
  | "unknown";

/**
 * A wait the letter promises in words rather than as a calendar date —
 * "FU 4 weeks", "review in about 6 weeks time", "negative at six weeks". The
 * model transcribes the phrase; turning it into a due date is deterministic
 * (see `dueDateFrom` in stateMachine.ts), so an unparseable phrase degrades to
 * "no stated due date" instead of an invented one.
 */
export interface StatedFollowUp {
  /** What is due, named as the letter names it ("full TB culture", "follow-up"). */
  item: string;
  /** The interval exactly as written; null when only an explicit date is given. */
  phrase: string | null;
  /**
   * The event the interval counts from, in the letter's words ("bronchoscopy").
   * Null means it counts from this letter's date.
   */
  from: string | null;
  /** An explicit due date the letter writes outright. */
  due_date: string | null;
}

export interface Extraction {
  /** Written letter date only; never inferred. */
  letter_date: string | null;
  department: string | null;
  clinicians: { name: string; dept: string | null }[];
  investigations: {
    /** Slug unique within this letter. */
    id: string;
    name: string;
    type: InvestigationType;
    ordered_date: string | null;
    report_date: string | null;
    status: InvestigationStatus;
  }[];
  findings: { text: string; on_investigation: string | null; spawned: string | null }[];
  referrals: {
    from_dept: string | null;
    to_dept: string | null;
    reason: string | null;
    date: string | null;
  }[];
  dependencies: {
    blocked_item: string;
    blocking_item: string;
    stated_status: string | null;
  }[];
  mdt: { date: string | null; outcome: string | null; awaiting: string | null }[];
  /**
   * The treatment or decision this letter says the pathway is working toward,
   * named exactly as the letter names it ("Start filgotinib"). The model may
   * only NAME it — it never decides what is stalled or how far along we are.
   * Optional so hand-authored fixtures stay valid; null when nothing is stated.
   */
  stated_goal?: string | null;
  /**
   * Waits this letter promises in words. Optional so hand-authored fixtures
   * stay valid; the deterministic layer treats a missing list as "none stated".
   */
  follow_ups?: StatedFollowUp[];
  /** 0..1. Low confidence is flagged, not guessed. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Dependency graph and deterministic stall detection
// ---------------------------------------------------------------------------

export type EdgeKind = "blocks" | "spawned_by" | "awaiting";

export type GraphNodeKind =
  | "investigation"
  | "referral"
  | "approval"
  | "finding"
  | "mdt";

export interface GraphNode {
  id: string;
  label: string;
  dept: string | null;
  kind: GraphNodeKind;
  /** Mirrors investigations.type when applicable. */
  invType: InvestigationType | null;
  status: string;
  ordered_date: string | null;
  report_date: string | null;
  expected_days: number | null;
  /**
   * The date this step belongs on a timeline: when it was carried out, else when
   * it was asked for. Null when no letter dates it at all.
   */
  timelineDate: string | null;
  /**
   * "written" when a letter gives this step a date of its own; "letter" when the
   * only date we have is the date of the letter that named it. A step named
   * without a date is still dated — a letter of 06-Feb asking for a chest X-ray
   * is evidence the request existed on 06-Feb — but the distinction is kept so
   * the UI never presents a derived date as a transcribed one.
   */
  dateSource: "written" | "letter" | null;
  /** When the letters promise this step by a date, that date. */
  dueDate: string | null;
  /** Set only while this step is open and past a date it should have met. */
  overdue: NodeOverdue | null;
}

/**
 * How late an open step is, and the plain-words reason it counts as late. The
 * UI renders `basis` verbatim, so it is written the way a clinic would say it.
 */
export interface NodeOverdue {
  daysOverdue: number;
  basis: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/** Where the pathway is trying to get to, always named by the letters. */
export type PathwayGoalSource =
  /** A letter states the intent outright (extraction.stated_goal). */
  | "stated"
  /** Derived deterministically from what the letters say (dependency terminal, treatment wording). */
  | "derived"
  /** No intent anywhere in the letters — the generic placeholder. */
  | "fallback";

export interface PathwayGoal {
  nodeId: string;
  label: string;
  dept: string | null;
  source: PathwayGoalSource;
}

export interface PathwayGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The terminal node of the pathway, inferred from the letters. */
  goal: PathwayGoal;
  /**
   * Ids of the nodes that actually reach the goal, in date order and ending at
   * the goal. Anything outside this list is an off-chain item the UI demotes.
   */
  chainIds: string[];
  /**
   * Whether any letter writes down what blocks what. False means the pathway is
   * a set of dated steps with no stated dependency between them — real letters
   * often are — and the graph must not demote a step or claim a route it was
   * never told about.
   */
  statedDependencies: boolean;
}

export interface Stall {
  stalledNode: GraphNode;
  /** Ordered from the stalled node downstream to the terminal goal. */
  chain: GraphNode[];
  owningDept: string | null;
  sinceDate: string | null;
  daysStalled: number;
  expectedDays: number | null;
  /** The date the letters promised this by, when they promise one. */
  dueDate: string | null;
  /** Days past `dueDate`, or past the generic expected wait when none is stated. */
  daysOverdue: number;
  /** Why this blocks the goal and who owns it — renderable as-is. */
  explanation: string;
}

/** Why there is no stall — "no stall" must never be confused with "not computed". */
export type NoStallReasonCode =
  /** Not one step carries a date, so nothing can be timed. */
  | "no_dated_nodes"
  /** Open steps exist but none of them connects to the goal. */
  | "no_path_to_goal"
  /** Everything open is still inside its expected window. */
  | "nothing_overdue";

export interface NoStallReason {
  code: NoStallReasonCode;
  /** Plain-English sentence the UI can render as-is. */
  message: string;
}

// ---------------------------------------------------------------------------
// Optional private-routing contract (coverage decisions remain deterministic)
// ---------------------------------------------------------------------------

export interface Coverage {
  plan_type: string | null;
  covers_diagnostics: boolean;
  covers_consults: boolean;
  requires_gp_referral: boolean;
  requires_preauth: boolean;
  excludes: string[];
  confidence: number;
}

export interface PrivateProvider {
  id: string;
  name: string;
  specialty: string;
  invTypes: InvestigationType[];
  region: string;
  indicative_wait_days: number;
  indicative_price_gbp: number;
}

export interface EscapeHatch {
  node: GraphNode;
  coverable: boolean;
  reason: string;
  providers: PrivateProvider[];
  caveats: string[];
}

// ---------------------------------------------------------------------------
// Module 3 — dormant vitals joiner (orthogonal to the critical path graph)
// ---------------------------------------------------------------------------

export type VitalMetric = "resting_hr" | "sleep_minutes" | "hrv" | "steps";

export interface VitalDelta {
  baseline: number;
  window_mean: number;
  absolute: number;
  percent: number;
}

export interface VitalsResult {
  baseline_window: { start: string; end: string; days: number };
  wait_window: { start: string; end: string; days: number };
  deltas: Record<VitalMetric, VitalDelta>;
  inflection: { date: string; metric: VitalMetric } | null;
}

// ---------------------------------------------------------------------------
// Administrative drafter
// ---------------------------------------------------------------------------

export type DraftTarget =
  | "advice_line"
  | "pals"
  | "clinician_summary"
  | "insurer_preauth"
  | "nhs_private_notice";

/** Targets that draft the private route rather than an NHS escalation. */
export const PRIVATE_ROUTE_TARGETS = ["insurer_preauth", "nhs_private_notice"] as const;

export interface DraftInput {
  stall: Stall;
  vitals: VitalsResult | null;
  target: DraftTarget;
  /**
   * Required by the private-route targets and ignored by every other target.
   * Must be a coverable hatch — a draft is never produced for a step that
   * cannot be routed privately.
   */
  escapeHatch?: EscapeHatch | null;
  meta?: {
    patient_name?: string;
    hospital?: string;
    nhs_number?: string;
  };
}

export interface DraftResult {
  target: DraftTarget;
  text: string;
  questions?: string[];
  mocked: boolean;
}
