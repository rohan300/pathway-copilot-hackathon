/** Date/SLA helpers retained for the Critical Path graph and stall detector. */

import type { InvestigationType } from "./types";

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

/**
 * The investigation type a step's NAME implies. Used to recover a type the
 * model omitted, and to file a promised follow-up under the same type as the
 * step it promises, so "repeat non-contrast CT" finds the CT already on the
 * graph instead of becoming an appointment of its own.
 */
export function typeFromName(name: string): InvestigationType {
  const text = name.toLowerCase();
  if (/bronch/.test(text)) return "bronchoscopy";
  if (/\bct\b|computed tomography/.test(text)) return "ct";
  if (/\bmri\b|magnetic resonance/.test(text)) return "mri";
  if (/x[- ]?ray|radiograph/.test(text)) return "xray";
  if (/blood|\bigra\b|serolog|culture|screening/.test(text)) return "bloods";
  if (/consult|clearance|review|follow[- ]?up|appointment|clinic/.test(text)) return "consult";
  return "other";
}

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

/** `iso` shifted by `days`, as YYYY-MM-DD. */
export function addDays(iso: string, days: number): string {
  return new Date(parseDate(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const UNIT_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

/**
 * Days meant by an interval a letter writes in words — "4 weeks", "in about 6
 * weeks time", "at the 3-month point", "next week", "six weeks". Returns null
 * when the phrase carries no interval, so the caller falls back to the generic
 * expected wait rather than inventing a deadline.
 *
 * Deliberately conservative: it reads a count and a unit and nothing else. A
 * month is 30 days, which is close enough for "is this overdue" and avoids
 * pretending to a precision the letters do not have.
 */
export function parseIntervalDays(phrase: string): number | null {
  const text = phrase.toLowerCase();

  // "next week", "next month" — the following whole unit.
  const next = text.match(/\bnext\s+(day|week|month|year)s?\b/);
  if (next) return UNIT_DAYS[next[1]];

  // A digit or a written number in front of a unit, with optional hyphen:
  // "4 weeks", "3-month point", "six weeks", "a week".
  const counted = text.match(
    /\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]+(day|week|month|year)s?\b/,
  );
  if (counted) {
    const count = /^\d+$/.test(counted[1]) ? Number(counted[1]) : NUMBER_WORDS[counted[1]];
    const unit = UNIT_DAYS[counted[2]];
    if (count && unit) return count * unit;
  }

  return null;
}

/**
 * The date an interval phrase lands on, counted from `anchor`. Null when the
 * phrase states no interval — "no stated due date" must never be confused with
 * a due date of today.
 */
export function dueDateFrom(anchor: string, phrase: string): string | null {
  const days = parseIntervalDays(phrase);
  return days === null ? null : addDays(anchor, days);
}
