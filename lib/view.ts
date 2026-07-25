/** Pure, client-safe helpers for the Critical Path UI and dormant vitals chart. */

import type { Extraction, VitalMetric } from "@/lib/pipeline/types";

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
