/**
 * Frontend API client for the Pathway Copilot pipeline.
 *
 * Wraps the four pipeline routes (+ the samples fixture) shipped in GLD-4.
 * Types come from the pipeline's own source of truth (`lib/pipeline/types`) —
 * a type-only import, so no server code is pulled into the client bundle.
 * Each route wraps its payload under a single key ({ extraction }, { state },
 * { vitals }, { draft }); this client unwraps them so callers get plain values.
 */
import type {
  Extraction,
  StateMachineResult,
  VitalsResult,
  DraftResult,
  DraftTarget,
} from "@/lib/pipeline/types";

export const ROUTES = {
  samples: "/api/samples",
  extract: "/api/extract",
  state: "/api/state",
  vitals: "/api/vitals",
  draft: "/api/draft",
} as const;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function unwrap<T>(res: Response, key: string): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body?.error || body?.message || detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail || `Request failed (${res.status})`, res.status);
  }
  const body = await res.json();
  return body[key] as T;
}

export interface SampleLetterMeta {
  id: string;
  title: string;
  text: string;
}
export interface SamplesResponse {
  letters: SampleLetterMeta[];
  fitbitCsv: string;
  startDate: string;
}

/** The bundled demo dataset — lets the whole screen run without any upload. */
export async function fetchSamples(): Promise<SamplesResponse> {
  const res = await fetch(ROUTES.samples, { cache: "no-store" });
  if (!res.ok) throw new ApiError("Could not load the sample data", res.status);
  return (await res.json()) as SamplesResponse;
}

/** Extract one bundled sample letter (by id) into strict JSON. */
export async function extractSample(sampleId: string): Promise<Extraction> {
  const res = await fetch(ROUTES.extract, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sampleId }),
  });
  return unwrap<Extraction>(res, "extraction");
}

/** Extract a user-supplied NHS letter (image) or pasted text. */
export async function extractUpload(input: {
  file?: File;
  text?: string;
}): Promise<Extraction> {
  const form = new FormData();
  if (input.file) form.append("file", input.file);
  if (input.text) form.append("text", input.text);
  const res = await fetch(ROUTES.extract, { method: "POST", body: form });
  return unwrap<Extraction>(res, "extraction");
}

/** Run the deterministic state machine over the extracted letters. */
export async function computeState(
  extractions: Extraction[],
  asOf?: string,
): Promise<StateMachineResult> {
  const res = await fetch(ROUTES.state, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ extractions, asOf }),
  });
  return unwrap<StateMachineResult>(res, "state");
}

/** Join a Fitbit CSV against the pathway start date. Deltas only. */
export async function joinVitals(
  csv: string,
  startDate: string,
): Promise<VitalsResult> {
  const res = await fetch(ROUTES.vitals, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csv, startDate }),
  });
  return unwrap<VitalsResult>(res, "vitals");
}

/** Draft a ready-to-send administrative escalation for the chosen target. */
export async function draftEscalation(input: {
  state: StateMachineResult;
  vitals: VitalsResult | null;
  target: DraftTarget;
}): Promise<DraftResult> {
  const res = await fetch(ROUTES.draft, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<DraftResult>(res, "draft");
}
