/**
 * Module 2 — Pathway state machine. DETERMINISTIC CODE, no LLM.
 *
 * Takes the array of extractor outputs and computes the current pathway stage,
 * how long the patient has been waiting, whether they are overdue, the current
 * blocker, and a comparison against the published benchmark. The LLM plays no
 * part here — clinical stage and urgency are decided by this code alone.
 */

import type { Extraction, Stage, StageSignal, StateMachineResult } from "./types";

/** Stages in order. `first_dose` is terminal (no expected-max wait). */
export const STAGE_ORDER: Stage[] = [
  "referral",
  "screening",
  "funding",
  "homecare",
  "first_dose",
];

/** Published expected maximum days per stage. */
export const EXPECTED_MAX_DAYS: Partial<Record<Stage, number>> = {
  referral: 14,
  screening: 21,
  funding: 28,
  homecare: 14,
};

/** Median wait, referral → first dose (NHS IBD biologics benchmark). */
export const BENCHMARK_MEDIAN_DAYS = 76;
export const BENCHMARK_IQR = "56–97";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse a "YYYY-MM-DD" string as a UTC-midnight timestamp. */
function parseDate(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days between two "YYYY-MM-DD" dates (floored, never negative). */
function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.floor((parseDate(to) - parseDate(from)) / DAY_MS));
}

/** Map a raw document stage signal to a canonical pathway stage. */
function toStage(signal: StageSignal): Stage | null {
  switch (signal) {
    case "referral":
      return "referral";
    case "screening":
      return "screening";
    case "funding":
      return "funding";
    case "homecare":
      return "homecare";
    case "dosing":
      return "first_dose";
    default:
      return null; // "unknown"
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildBenchmark(totalDays: number): string {
  const median = BENCHMARK_MEDIAN_DAYS;
  if (totalDays > median) {
    const over = totalDays - median;
    return `${totalDays} days elapsed so far — ${over} day${over === 1 ? "" : "s"} above the ${median}-day median wait from referral to first dose (IQR ${BENCHMARK_IQR}).`;
  }
  const under = median - totalDays;
  return `${totalDays} days elapsed so far — ${under} day${under === 1 ? "" : "s"} below the ${median}-day median wait from referral to first dose (IQR ${BENCHMARK_IQR}).`;
}

/**
 * Run the deterministic state machine over sorted extractor outputs.
 *
 * @param extractions Extractor outputs (any order; only dated ones are used).
 * @param asOf        Reference date ("YYYY-MM-DD"), defaults to today. The
 *                    patient is still waiting, so elapsed time is measured to now.
 */
export function runStateMachine(
  extractions: Extraction[],
  asOf: string = todayISO(),
): StateMachineResult {
  // Only documents with a written date participate — dates are never inferred.
  const dated = extractions
    .filter((e): e is Extraction & { date: string } => Boolean(e.date))
    .sort((a, b) => parseDate(a.date) - parseDate(b.date));

  if (dated.length === 0) {
    return {
      current_stage: "referral",
      days_in_stage: 0,
      total_days_elapsed: 0,
      overdue: false,
      blocker: "No dated documents provided — cannot reconstruct the pathway.",
      benchmark_comparison: buildBenchmark(0),
    };
  }

  const startDate = dated[0].date;
  const totalDays = daysBetween(startDate, asOf);

  // Current stage = latest known (non-unknown) stage signal.
  let currentStage: Stage = "referral";
  for (const e of dated) {
    const s = toStage(e.stage_signal);
    if (s) currentStage = s;
  }

  // Days in stage = time since the first document that signalled the current
  // stage (stages only advance, so those documents are the trailing run).
  const stageEntries = dated.filter((e) => toStage(e.stage_signal) === currentStage);
  const stageStart = stageEntries.length ? stageEntries[0].date : startDate;
  const daysInStage = daysBetween(stageStart, asOf);

  const expected = EXPECTED_MAX_DAYS[currentStage];
  const overdue = expected !== undefined && daysInStage > expected;

  // Blocker = the most recent stated action with no subsequent confirming
  // document. The latest document with any actions_stated holds the outstanding
  // ask (nothing later has responded to it).
  let blocker = "No outstanding action identified in the documents.";
  for (let i = dated.length - 1; i >= 0; i--) {
    if (dated[i].actions_stated.length > 0) {
      blocker = dated[i].actions_stated.join("; ");
      break;
    }
  }

  return {
    current_stage: currentStage,
    days_in_stage: daysInStage,
    total_days_elapsed: totalDays,
    overdue,
    blocker,
    benchmark_comparison: buildBenchmark(totalDays),
  };
}
