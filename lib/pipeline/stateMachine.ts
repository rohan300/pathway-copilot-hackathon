/** Date/SLA helpers retained for the Critical Path graph and stall detector. */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Expected maximum wait by graph node type / normalized investigation type. */
export const EXPECTED_MAX_DAYS: Record<string, number> = {
  referral: 21,
  approval: 28,
  mdt: 14,
  finding: 0,
  ct: 21,
  mri: 21,
  bronchoscopy: 28,
  consult: 21,
  bloods: 7,
  xray: 14,
  other: 14,
};

/** Parse a valid YYYY-MM-DD string as a UTC-midnight timestamp. */
export function parseDate(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Whole non-negative days between two YYYY-MM-DD dates. */
export function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.floor((parseDate(to) - parseDate(from)) / DAY_MS));
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
