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
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface PathwayGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Stall {
  stalledNode: GraphNode;
  /** Ordered from the stalled node downstream to the terminal goal. */
  chain: GraphNode[];
  owningDept: string | null;
  sinceDate: string | null;
  daysStalled: number;
  expectedDays: number | null;
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

export type DraftTarget = "advice_line" | "pals" | "clinician_summary";

export interface DraftInput {
  stall: Stall;
  vitals: VitalsResult | null;
  target: DraftTarget;
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
