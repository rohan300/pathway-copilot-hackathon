/**
 * Pure, client-safe view helpers — turn pipeline output into the view models
 * the Companion screen renders. Type-only imports from the pipeline (no runtime
 * pulled into the client bundle). Stage benchmarks mirror the deterministic
 * state machine (`lib/pipeline/stateMachine.ts` — EXPECTED_MAX_DAYS); the UI
 * never decides stage or urgency, it only renders what the pipeline returns.
 */
import type {
  Extraction,
  Stage,
  StageSignal,
  StateMachineResult,
  VitalMetric,
} from "@/lib/pipeline/types";

/** An extraction plus where it came from (filename / sample title). */
export interface DocRecord extends Extraction {
  id: string;
  source: string;
}

/** Canonical pathway stages, in order. `first_dose` is terminal. */
export const STAGES: Stage[] = [
  "referral",
  "screening",
  "funding",
  "homecare",
  "first_dose",
];

const STAGE_LABELS: Record<Stage, string> = {
  referral: "Referral",
  screening: "Screening",
  funding: "Funding",
  homecare: "Homecare setup",
  first_dose: "First dose",
};

/** Expected max days per stage — mirrors EXPECTED_MAX_DAYS in the state machine. */
const EXPECTED_DAYS: Partial<Record<Stage, number>> = {
  referral: 14,
  screening: 21,
  funding: 28,
  homecare: 14,
};

/** One line of plain-English "what usually happens here" for awaiting stages. */
const STAGE_ABOUT: Record<Stage, string> = {
  referral: "Your GP refers you to the hospital IBD team to consider biologic treatment.",
  screening: "Before biologics can start, the team runs screening bloods and a TB check.",
  funding: "A funding application goes to the panel; treatment can't be arranged until it's approved.",
  homecare:
    "Once funding is approved, a homecare provider arranges your medication and any training to self-inject at home.",
  first_dose:
    "Your first dose of the biologic — the end of the pathway. It becomes available once homecare setup is complete.",
};

export type StageStatus = "complete" | "current" | "upcoming";

export interface Milestone {
  stage: Stage;
  label: string;
  about: string;
  status: StageStatus;
  overdue: boolean;
  expectedDays: number | null;
  docs: DocRecord[];
}

/** Map an extractor `stage_signal` onto a canonical pathway stage. */
export function signalToStage(signal: StageSignal): Stage | null {
  if (signal === "dosing") return "first_dose";
  if (signal === "unknown") return null;
  return signal; // referral | screening | funding | homecare
}

/**
 * Build the 5 canonical milestones: status (complete/current/upcoming), the
 * overdue flag (only ever on the current stage, straight from the state
 * machine), and any extracted letters attached to each stage.
 */
export function buildMilestones(
  docs: DocRecord[],
  state: StateMachineResult | null,
): Milestone[] {
  const currentIdx = state ? STAGES.indexOf(state.current_stage) : -1;

  const byStage = new Map<Stage, DocRecord[]>();
  for (const doc of docs) {
    const stage = signalToStage(doc.stage_signal);
    if (!stage) continue;
    const list = byStage.get(stage) ?? [];
    list.push(doc);
    byStage.set(stage, list);
  }
  for (const list of byStage.values()) {
    list.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }

  return STAGES.map((stage, idx) => {
    let status: StageStatus = "upcoming";
    if (currentIdx >= 0) {
      if (idx < currentIdx) status = "complete";
      else if (idx === currentIdx) status = "current";
    }
    return {
      stage,
      label: STAGE_LABELS[stage],
      about: STAGE_ABOUT[stage],
      status,
      overdue: status === "current" && Boolean(state?.overdue),
      expectedDays: EXPECTED_DAYS[stage] ?? null,
      docs: byStage.get(stage) ?? [],
    };
  });
}

/** Earliest written date across the letters — the pathway start for vitals. */
export function pathwayStartDate(docs: DocRecord[]): string | null {
  const dated = docs.map((d) => d.date).filter((d): d is string => Boolean(d));
  if (dated.length === 0) return null;
  return [...dated].sort()[0];
}

/** e.g. "2026-05-27" -> "27 May 2026". Returns "—" for null/invalid. */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Vitals — the API returns deltas + an inflection date only (no series). To
// draw the real line, we parse the CSV client-side. Same column aliases and
// sort as the deterministic joiner, so the plotted series matches its maths.
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
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col: Partial<Record<keyof CsvPoint, number>> = {};
  header.forEach((h, i) => {
    const key = HEADER_ALIASES[h];
    if (key && col[key] === undefined) col[key] = i;
  });
  if (col.date === undefined) return [];

  const points: CsvPoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const date = cells[col.date]?.trim();
    if (!date) continue;
    const num = (k: keyof CsvPoint): number => {
      const idx = col[k];
      const v = idx === undefined ? NaN : Number(cells[idx]);
      return Number.isFinite(v) ? v : 0;
    };
    points.push({
      date,
      resting_hr: num("resting_hr"),
      sleep_minutes: num("sleep_minutes"),
      hrv: num("hrv"),
      steps: num("steps"),
    });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

/** Display metadata per metric — label, unit, and whether a rise is adverse. */
export const METRIC_META: Record<
  VitalMetric,
  { label: string; short: string; unit: string; riseIsAdverse: boolean; format: (n: number) => string }
> = {
  resting_hr: {
    label: "Resting heart rate",
    short: "Resting HR",
    unit: "bpm",
    riseIsAdverse: true,
    format: (n) => `${Math.round(n)}`,
  },
  hrv: {
    label: "Heart-rate variability",
    short: "HRV",
    unit: "ms",
    riseIsAdverse: false,
    format: (n) => `${Math.round(n)}`,
  },
  sleep_minutes: {
    label: "Sleep",
    short: "Sleep",
    unit: "",
    riseIsAdverse: false,
    format: (n) => {
      const h = Math.floor(n / 60);
      const m = Math.round(n % 60);
      return `${h}h ${m}m`;
    },
  },
  steps: {
    label: "Daily steps",
    short: "Steps",
    unit: "",
    riseIsAdverse: false,
    format: (n) => Math.round(n).toLocaleString("en-GB"),
  },
};

export const METRIC_ORDER: VitalMetric[] = ["resting_hr", "hrv", "sleep_minutes", "steps"];
