/**
 * Frontend API client for the Pathway Copilot pipeline.
 *
 * Wraps the graph pipeline routes (+ the samples fixture).
 * Types come from the pipeline's own source of truth (`lib/pipeline/types`) —
 * a type-only import, so no server code is pulled into the client bundle.
 * Each route wraps its payload under a single key ({ extraction }, { graph, stall },
 * { vitals }, { draft }); this client unwraps them so callers get plain values.
 */
import type {
  Coverage,
  EscapeHatch,
  Extraction,
  PathwayGraph,
  Stall,
  VitalsResult,
  DraftResult,
  DraftTarget,
} from "@/lib/pipeline/types";

export const ROUTES = {
  samples: "/api/samples",
  extract: "/api/extract",
  graph: "/api/graph",
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

export interface GraphResult {
  graph: PathwayGraph;
  stall: Stall | null;
  /** Null unless coverage was supplied and the stalled node is coverable. */
  escapeHatch: EscapeHatch | null;
}

/**
 * Build the deterministic dependency graph and identify its stall.
 *
 * `coverage` is optional: pass the user's declared private cover to also get
 * back the escape hatch for the stalled node. Omit it (the default) and the
 * request is identical to a pre-coverage one — escalation only.
 */
export async function computeGraph(
  extractions: Extraction[],
  asOf?: string,
  coverage?: Coverage | null,
): Promise<GraphResult> {
  const res = await fetch(ROUTES.graph, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Absent coverage is omitted rather than sent as null, so the no-cover
    // request body stays exactly what it was before this route grew the field.
    body: JSON.stringify({ extractions, asOf, ...(coverage ? { coverage } : {}) }),
  });
  // Several keys in one payload, so unwrap() (single-key) does not apply; the
  // error handling has to match it explicitly.
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
  return {
    graph: body.graph as PathwayGraph,
    stall: body.stall as Stall | null,
    escapeHatch: (body.escapeHatch ?? null) as EscapeHatch | null,
  };
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

/**
 * Draft a ready-to-send administrative escalation for the chosen target.
 * `escapeHatch` is required by the private-route targets (insurer_preauth /
 * nhs_private_notice) and ignored by every other one; the route refuses to
 * draft a private-route message for a step that is not coverable.
 */
export async function draftEscalation(input: {
  stall: Stall;
  vitals: VitalsResult | null;
  target: DraftTarget;
  escapeHatch?: EscapeHatch | null;
}): Promise<DraftResult> {
  const res = await fetch(ROUTES.draft, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<DraftResult>(res, "draft");
}
