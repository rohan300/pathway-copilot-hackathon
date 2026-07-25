/**
 * Deterministic sample data so the demo runs end-to-end WITHOUT an OpenAI key.
 *
 * Each sample letter ships with the exact extraction the extractor would
 * produce, so mock mode returns real, coherent output. The Fitbit CSV is
 * generated deterministically (seeded) — no randomness, no persistence.
 *
 * Story: a patient referred for biologics on 2026-04-22, now stuck in the
 * funding stage (Blueteq panel) well past the expected 28-day window.
 */

import type { Extraction } from "./types";

export interface SampleLetter {
  id: string;
  title: string;
  /** The letter text shown in the UI / sent to the LLM when a key is present. */
  text: string;
  /** The extraction the pipeline yields for this letter (used in mock mode). */
  extraction: Extraction;
}

export const SAMPLE_LETTERS: SampleLetter[] = [
  {
    id: "referral",
    title: "GP referral to Gastroenterology",
    text: `Dr A. Okafor — The Grove Surgery
Date: 22 April 2026
Re: Mr J. Patient (DOB 14/03/1991)

Dear Gastroenterology Team,

I am referring this patient with a confirmed diagnosis of Crohn's disease for
consideration of biologic therapy. Symptoms are not controlled on current
treatment. Please assess for anti-TNF / biologics initiation.

Yours faithfully,
Dr A. Okafor`,
    extraction: {
      date: "2026-04-22",
      doc_type: "referral",
      stage_signal: "referral",
      clinician: "Dr A. Okafor",
      actions_stated: ["Assess patient for biologic (anti-TNF) therapy"],
      tests_ordered: [],
      drugs_mentioned: ["anti-TNF"],
      confidence: 0.94,
    },
  },
  {
    id: "clinic",
    title: "Gastroenterology clinic letter",
    text: `St. Mary's Hospital — Department of Gastroenterology
Clinic date: 6 May 2026
Consultant: Dr H. Reyes

Dear colleague,

I reviewed Mr Patient in clinic today. We plan to commence infliximab. Prior to
starting, pre-biologic screening bloods and a TB screen (IGRA) and chest X-ray
have been requested. We will submit a funding application once screening is clear.

Kind regards,
Dr H. Reyes`,
    extraction: {
      date: "2026-05-06",
      doc_type: "clinic_letter",
      stage_signal: "screening",
      clinician: "Dr H. Reyes",
      actions_stated: [
        "Complete pre-biologic screening bloods, IGRA and chest X-ray",
        "Submit funding application once screening is clear",
      ],
      tests_ordered: ["Pre-biologic screening bloods", "IGRA (TB screen)", "Chest X-ray"],
      drugs_mentioned: ["infliximab"],
      confidence: 0.91,
    },
  },
  {
    id: "funding",
    title: "Funding application acknowledgement",
    text: `St. Mary's Hospital — Biologics Team
Date: 27 May 2026

Dear Mr Patient,

Screening is complete. A funding application (Blueteq) for infliximab has been
submitted to the funding panel. We are awaiting the panel's decision before
your treatment can be arranged. We will contact you once a decision is made.

Biologics Coordinator`,
    extraction: {
      date: "2026-05-27",
      doc_type: "funding",
      stage_signal: "funding",
      clinician: null,
      actions_stated: [
        "Await funding panel (Blueteq) decision for infliximab before treatment can be arranged",
      ],
      tests_ordered: [],
      drugs_mentioned: ["infliximab"],
      confidence: 0.9,
    },
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic pseudo-noise in [-1, 1] from an integer seed. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * Generate a seeded Fitbit CSV from 2026-04-20 to 2026-07-15.
 * Resting HR and HRV drift adversely after the funding stall (~late May);
 * this is objective context only — never interpreted clinically.
 */
export function generateFitbitCsv(): string {
  const start = Date.UTC(2026, 3, 20); // 2026-04-20
  const end = Date.UTC(2026, 6, 15); // 2026-07-15
  const inflection = Date.UTC(2026, 4, 27); // funding stall

  const lines = ["date,resting_hr,sleep_minutes,hrv,steps"];
  for (let t = start, i = 0; t <= end; t += DAY_MS, i++) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const post = t >= inflection ? (t - inflection) / DAY_MS : 0;
    const ramp = Math.min(1, post / 30); // ease over ~30 days

    const restingHr = Math.round(58 + 8 * ramp + noise(i) * 1.5);
    const hrv = Math.round(46 - 12 * ramp + noise(i + 100) * 3);
    const sleep = Math.round(432 - 50 * ramp + noise(i + 200) * 15);
    const steps = Math.round(8600 - 2600 * ramp + noise(i + 300) * 400);

    lines.push(`${iso},${restingHr},${sleep},${hrv},${steps}`);
  }
  return lines.join("\n");
}

export const SAMPLE_FITBIT_CSV = generateFitbitCsv();

/** Pathway start date for the sample (the referral date). */
export const SAMPLE_START_DATE = "2026-04-22";
