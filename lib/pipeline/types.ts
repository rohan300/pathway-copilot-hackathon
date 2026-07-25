/**
 * Shared types for the Pathway Copilot pipeline.
 *
 * Pipeline order (fixed): extractor -> state machine -> vitals joiner -> drafter.
 * The extractor and drafter are LLM-backed; the state machine and vitals joiner
 * are DETERMINISTIC CODE. LLMs never decide clinical stage or urgency.
 */

// ---------------------------------------------------------------------------
// Agent 1 — Extractor
// ---------------------------------------------------------------------------

export type DocType =
  | "referral"
  | "clinic_letter"
  | "test_result"
  | "funding"
  | "homecare"
  | "other";

/** Raw stage signal as read from a single document. */
export type StageSignal =
  | "referral"
  | "screening"
  | "funding"
  | "homecare"
  | "dosing"
  | "unknown";

/** Strict extractor output — one per NHS letter. Absent fields are null/[]. */
export interface Extraction {
  /** Document date, "YYYY-MM-DD". Never inferred — null if not written. */
  date: string | null;
  doc_type: DocType;
  stage_signal: StageSignal;
  clinician: string | null;
  actions_stated: string[];
  tests_ordered: string[];
  drugs_mentioned: string[];
  /** 0.0–1.0. Low confidence is flagged, not guessed away. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Module 2 — State machine (deterministic)
// ---------------------------------------------------------------------------

/** Canonical pathway stages, in order. `first_dose` is terminal. */
export type Stage =
  | "referral"
  | "screening"
  | "funding"
  | "homecare"
  | "first_dose";

export interface StateMachineResult {
  current_stage: Stage;
  days_in_stage: number;
  total_days_elapsed: number;
  overdue: boolean;
  blocker: string;
  benchmark_comparison: string;
}

// ---------------------------------------------------------------------------
// Module 3 — Vitals joiner (deterministic, no interpretation)
// ---------------------------------------------------------------------------

export type VitalMetric = "resting_hr" | "sleep_minutes" | "hrv" | "steps";

export interface VitalDelta {
  baseline: number;
  window_mean: number;
  /** window_mean - baseline. */
  absolute: number;
  /** Percent change vs baseline. */
  percent: number;
}

export interface VitalsResult {
  baseline_window: { start: string; end: string; days: number };
  wait_window: { start: string; end: string; days: number };
  deltas: Record<VitalMetric, VitalDelta>;
  /** Date of the largest sustained change across metrics, or null if too few rows. */
  inflection: { date: string; metric: VitalMetric } | null;
}

// ---------------------------------------------------------------------------
// Agent 4 — Drafter
// ---------------------------------------------------------------------------

export type DraftTarget = "advice_line" | "pals" | "clinician_summary";

export interface DraftInput {
  state: StateMachineResult;
  vitals: VitalsResult | null;
  target: DraftTarget;
  /** Optional patient-supplied context (name, hospital) to personalise the draft. */
  meta?: {
    patient_name?: string;
    hospital?: string;
    nhs_number?: string;
  };
}

export interface DraftResult {
  target: DraftTarget;
  /** Ready-to-send prose. For clinician_summary this is the structured one-pager. */
  text: string;
  /** For clinician_summary only: short list of questions the patient should ask. */
  questions?: string[];
  /** True when produced by the deterministic mock (no RUNWARE_API_KEY). */
  mocked: boolean;
}
