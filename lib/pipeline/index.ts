/** Pathway Copilot pipeline — public surface for the UI and API routes. */

export * from "./types";
export { extractLetter } from "./extractor";
export type { ExtractInput } from "./extractor";
export {
  runStateMachine,
  STAGE_ORDER,
  EXPECTED_MAX_DAYS,
  BENCHMARK_MEDIAN_DAYS,
  BENCHMARK_IQR,
} from "./stateMachine";
export { joinVitals, parseFitbitCsv } from "./vitals";
export { draft } from "./drafter";
export {
  SAMPLE_LETTERS,
  SAMPLE_FITBIT_CSV,
  SAMPLE_START_DATE,
  generateFitbitCsv,
} from "./samples";
export type { SampleLetter } from "./samples";
