/**
 * Critical Path demo oracle: six letters, two departments, eight graph nodes.
 * The final repeat CT is overdue; it blocks Respiratory clearance, which blocks
 * Gastroenterology's jak-inhibitor approval.
 */

import type { Extraction } from "./types";

export interface SampleLetter {
  id: string;
  title: string;
  text: string;
  extraction: Extraction;
  /** One sample may exercise Runware when a key is configured. */
  live?: boolean;
}

export const SAMPLE_LETTERS: SampleLetter[] = [
  {
    id: "gastro-referral",
    title: "Gastroenterology treatment plan",
    live: true,
    text: `St Mary's Hospital — Gastroenterology
Clinic date: 20 March 2026
Consultant: Dr H. Reyes

We agree to seek approval for a JAK inhibitor. Before approval, please complete
TB screening bloods and arrange a chest X-ray. The approval is awaiting
Respiratory clearance if the chest X-ray raises a finding.

Dr H. Reyes`,
    extraction: {
      letter_date: "2026-03-20",
      department: "Gastroenterology",
      clinicians: [{ name: "Dr H. Reyes", dept: "Gastroenterology" }],
      investigations: [
        {
          id: "tb-screening-bloods",
          name: "TB screening bloods",
          type: "bloods",
          ordered_date: "2026-03-20",
          report_date: "2026-03-24",
          status: "reported",
        },
      ],
      findings: [],
      referrals: [],
      dependencies: [
        {
          blocked_item: "jak inhibitor approval",
          blocking_item: "Respiratory clearance",
          stated_status: "awaiting",
        },
      ],
      mdt: [],
      confidence: 0.95,
    },
  },
  {
    id: "respiratory-xray",
    title: "Respiratory chest X-ray report",
    text: `Respiratory Department
Report date: 27 March 2026

Investigation: TB-screening chest X-ray, performed 20 March 2026.
The report records an incidental pulmonary finding requiring further review.
This finding has spawned a CT chest request.

Respiratory reporting team`,
    extraction: {
      letter_date: "2026-03-27",
      department: "Respiratory",
      clinicians: [],
      investigations: [
        {
          id: "tb-screening-chest-xray",
          name: "TB-screening chest X-ray",
          type: "xray",
          ordered_date: "2026-03-20",
          report_date: "2026-03-27",
          status: "reported",
        },
      ],
      findings: [
        {
          text: "Incidental pulmonary finding requiring further review",
          on_investigation: "TB-screening chest X-ray",
          spawned: "CT chest",
        },
      ],
      referrals: [],
      dependencies: [],
      mdt: [],
      confidence: 0.93,
    },
  },
  {
    id: "respiratory-ct",
    title: "Respiratory CT request and report",
    text: `Respiratory Department
Report date: 15 April 2026

Following the incidental finding on the chest X-ray, a CT chest was ordered on
28 March 2026 and reported on 15 April 2026. The CT report says that a
bronchoscopy is required before Respiratory can provide clearance for the
proposed JAK inhibitor approval.

Respiratory team`,
    extraction: {
      letter_date: "2026-04-15",
      department: "Respiratory",
      clinicians: [],
      investigations: [
        {
          id: "ct-chest",
          name: "CT chest",
          type: "ct",
          ordered_date: "2026-03-28",
          report_date: "2026-04-15",
          status: "reported",
        },
      ],
      findings: [
        {
          text: "CT report requires bronchoscopy before Respiratory clearance",
          on_investigation: "CT chest",
          spawned: "Bronchoscopy",
        },
      ],
      referrals: [],
      dependencies: [],
      mdt: [],
      confidence: 0.92,
    },
  },
  {
    id: "respiratory-referral",
    title: "Respiratory clearance referral",
    text: `Gastroenterology to Respiratory referral
Date: 16 April 2026

Please provide Respiratory clearance for the planned JAK inhibitor approval
after the incidental pulmonary finding on TB-screening imaging has been
reviewed. The patient remains under the Gastroenterology pathway.

Gastroenterology admin team`,
    extraction: {
      letter_date: "2026-04-16",
      department: "Gastroenterology",
      clinicians: [],
      investigations: [],
      findings: [],
      referrals: [
        {
          from_dept: "Gastroenterology",
          to_dept: "Respiratory",
          reason: "Respiratory clearance for JAK inhibitor approval",
          date: "2026-04-16",
        },
      ],
      dependencies: [],
      mdt: [],
      confidence: 0.94,
    },
  },
  {
    id: "respiratory-bronchoscopy",
    title: "Bronchoscopy report",
    text: `Respiratory Department
Procedure date: 20 May 2026

Bronchoscopy was performed on 20 May 2026 as the next step after the CT chest.
The report requests a repeat CT chest before the Respiratory clearance can be
closed.

Respiratory procedures team`,
    extraction: {
      letter_date: "2026-05-20",
      department: "Respiratory",
      clinicians: [],
      investigations: [
        {
          id: "bronchoscopy",
          name: "Bronchoscopy",
          type: "bronchoscopy",
          ordered_date: "2026-05-01",
          report_date: "2026-05-20",
          status: "reported",
        },
      ],
      findings: [
        {
          text: "Bronchoscopy report requests a repeat CT chest",
          on_investigation: "Bronchoscopy",
          spawned: "Repeat CT chest",
        },
      ],
      referrals: [],
      dependencies: [],
      mdt: [],
      confidence: 0.93,
    },
  },
  {
    id: "respiratory-repeat-ct",
    title: "Repeat CT request still open",
    text: `Respiratory Department
Clinic letter date: 10 June 2026

Following the bronchoscopy report, a repeat CT chest was ordered on 10 June
2026, to be carried out and reported within 3 weeks. The report has not yet
been returned. Respiratory clearance remains open awaiting the repeat CT chest,
and Gastroenterology's JAK inhibitor approval is awaiting that clearance.

Respiratory bookings team`,
    extraction: {
      letter_date: "2026-06-10",
      department: "Respiratory",
      clinicians: [],
      investigations: [
        {
          id: "repeat-ct-chest",
          name: "Repeat CT chest",
          type: "ct",
          ordered_date: "2026-06-10",
          report_date: null,
          status: "ordered",
        },
      ],
      findings: [],
      referrals: [],
      dependencies: [
        {
          blocked_item: "Respiratory clearance",
          blocking_item: "Repeat CT chest",
          stated_status: "awaiting",
        },
        {
          blocked_item: "jak inhibitor approval",
          blocking_item: "Respiratory clearance",
          stated_status: "awaiting",
        },
      ],
      mdt: [],
      follow_ups: [
        {
          item: "Repeat CT chest",
          phrase: "3 weeks",
          from: null,
          due_date: null,
        },
      ],
      confidence: 0.96,
    },
  },
  {
    id: "gastro-approval",
    title: "JAK inhibitor approval acknowledgement",
    text: `Gastroenterology biologics team
Date: 2 July 2026

The JAK inhibitor approval request remains open. We are awaiting Respiratory
clearance before the approval can be completed. No treatment date has been
arranged.

Biologics coordinator`,
    extraction: {
      letter_date: "2026-07-02",
      department: "Gastroenterology",
      clinicians: [],
      investigations: [],
      findings: [],
      referrals: [],
      dependencies: [
        {
          blocked_item: "jak inhibitor approval",
          blocking_item: "Respiratory clearance",
          stated_status: "awaiting",
        },
      ],
      mdt: [{ date: "2026-07-02", outcome: null, awaiting: "Respiratory clearance" }],
      confidence: 0.95,
    },
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** Keep the dormant Fitbit demo coherent with the new four-month pathway. */
export function generateFitbitCsv(): string {
  const start = Date.UTC(2026, 2, 15);
  const end = Date.UTC(2026, 6, 15);
  const inflection = Date.UTC(2026, 5, 10);
  const lines = ["date,resting_hr,sleep_minutes,hrv,steps"];
  for (let t = start, i = 0; t <= end; t += DAY_MS, i++) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const post = t >= inflection ? (t - inflection) / DAY_MS : 0;
    const ramp = Math.min(1, post / 30);
    lines.push(
      `${iso},${Math.round(58 + 8 * ramp + noise(i) * 1.5)},${Math.round(432 - 50 * ramp + noise(i + 200) * 15)},${Math.round(46 - 12 * ramp + noise(i + 100) * 3)},${Math.round(8600 - 2600 * ramp + noise(i + 300) * 400)}`,
    );
  }
  return lines.join("\n");
}

export const SAMPLE_FITBIT_CSV = generateFitbitCsv();
export const SAMPLE_START_DATE = "2026-03-20";
