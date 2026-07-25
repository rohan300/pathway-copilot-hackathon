/**
 * Module 3 — Vitals joiner. DETERMINISTIC CODE, no interpretation.
 *
 * Joins a Fitbit CSV against the pathway start date and reports, per metric,
 * the change from a 7-day baseline over the wait window, plus the date of the
 * largest sustained change. It does NOT predict, classify, or interpret
 * clinically — deltas only. Downstream, vitals are presented as objective
 * context, never as evidence of disease activity.
 */

import type { VitalMetric, VitalsResult, VitalDelta } from "./types";

const METRICS: VitalMetric[] = ["resting_hr", "sleep_minutes", "hrv", "steps"];

/** Header aliases → canonical metric key. */
const HEADER_ALIASES: Record<string, VitalMetric | "date"> = {
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

interface Row {
  date: string;
  resting_hr: number;
  sleep_minutes: number;
  hrv: number;
  steps: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Parse a Fitbit CSV (header + rows) into typed, date-sorted rows. */
export function parseFitbitCsv(csv: string): Row[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const colIndex: Partial<Record<VitalMetric | "date", number>> = {};
  header.forEach((h, i) => {
    const key = HEADER_ALIASES[h];
    if (key && colIndex[key] === undefined) colIndex[key] = i;
  });
  if (colIndex.date === undefined) return [];

  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const date = cells[colIndex.date!]?.trim();
    if (!date) continue;
    const num = (key: VitalMetric): number => {
      const idx = colIndex[key];
      const v = idx === undefined ? NaN : Number(cells[idx]);
      return Number.isFinite(v) ? v : 0;
    };
    rows.push({
      date,
      resting_hr: num("resting_hr"),
      sleep_minutes: num("sleep_minutes"),
      hrv: num("hrv"),
      steps: num("steps"),
    });
  }
  return rows.sort((a, b) => parseDate(a.date) - parseDate(b.date));
}

/**
 * Join Fitbit vitals against the pathway start date and report deltas.
 *
 * @param csv       Fitbit CSV: date, resting_hr, sleep_minutes, hrv, steps.
 * @param startDate Pathway start date ("YYYY-MM-DD"). The wait window runs from
 *                  here to the last row.
 */
export function joinVitals(csv: string, startDate: string): VitalsResult | null {
  const rows = parseFitbitCsv(csv);
  if (rows.length < 2) return null;

  // Baseline = first 7 calendar days of data.
  const firstDay = parseDate(rows[0].date);
  const baselineRows = rows.filter(
    (r) => parseDate(r.date) < firstDay + 7 * DAY_MS,
  );
  const baselineSet = baselineRows.length ? baselineRows : rows.slice(0, 1);

  // Wait window = rows on/after the pathway start date.
  const startTs = parseDate(startDate);
  const waitRows = rows.filter((r) => parseDate(r.date) >= startTs);
  const waitSet = waitRows.length ? waitRows : rows;

  const deltas = {} as Record<VitalMetric, VitalDelta>;
  for (const metric of METRICS) {
    const baseline = round(mean(baselineSet.map((r) => r[metric])));
    const windowMean = round(mean(waitSet.map((r) => r[metric])));
    const absolute = round(windowMean - baseline);
    const percent = baseline !== 0 ? round((absolute / baseline) * 100) : 0;
    deltas[metric] = {
      baseline,
      window_mean: windowMean,
      absolute,
      percent,
    };
  }

  return {
    baseline_window: {
      start: baselineSet[0].date,
      end: baselineSet[baselineSet.length - 1].date,
      days: baselineSet.length,
    },
    wait_window: {
      start: waitSet[0].date,
      end: waitSet[waitSet.length - 1].date,
      days: waitSet.length,
    },
    deltas,
    inflection: findInflection(rows),
  };
}

/**
 * Date of the largest sustained change across metrics. For each candidate split
 * we z-normalise each metric, compare the mean before vs after, and pick the
 * split that maximises the summed absolute normalised shift. Purely descriptive.
 */
function findInflection(rows: Row[]): { date: string; metric: VitalMetric } | null {
  const MIN_SIDE = 3;
  if (rows.length < MIN_SIDE * 2) return null;

  const stds: Record<VitalMetric, number> = {
    resting_hr: std(rows.map((r) => r.resting_hr)) || 1,
    sleep_minutes: std(rows.map((r) => r.sleep_minutes)) || 1,
    hrv: std(rows.map((r) => r.hrv)) || 1,
    steps: std(rows.map((r) => r.steps)) || 1,
  };

  let best = { score: -1, index: -1, metric: "resting_hr" as VitalMetric };
  for (let i = MIN_SIDE; i <= rows.length - MIN_SIDE; i++) {
    const before = rows.slice(0, i);
    const after = rows.slice(i);
    let sum = 0;
    let topMetric: VitalMetric = "resting_hr";
    let topShift = -1;
    for (const metric of METRICS) {
      const shift =
        Math.abs(mean(after.map((r) => r[metric])) - mean(before.map((r) => r[metric]))) /
        stds[metric];
      sum += shift;
      if (shift > topShift) {
        topShift = shift;
        topMetric = metric;
      }
    }
    if (sum > best.score) best = { score: sum, index: i, metric: topMetric };
  }

  if (best.index < 0) return null;
  return { date: rows[best.index].date, metric: best.metric };
}
