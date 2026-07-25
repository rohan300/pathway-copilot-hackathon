import { NextResponse } from "next/server";
import { SAMPLE_LETTERS, SAMPLE_FITBIT_CSV, SAMPLE_START_DATE } from "@/lib/pipeline";

/**
 * GET /api/samples — the demo dataset so the UI runs end-to-end without a key.
 * Returns the sample letters (id, title, text), the Fitbit CSV, and the
 * pathway start date. Extractions are intentionally not exposed — the UI POSTs
 * each letter to /api/extract, exercising the real pipeline.
 */
export function GET() {
  return NextResponse.json({
    letters: SAMPLE_LETTERS.map(({ id, title, text }) => ({ id, title, text })),
    fitbitCsv: SAMPLE_FITBIT_CSV,
    startDate: SAMPLE_START_DATE,
  });
}
