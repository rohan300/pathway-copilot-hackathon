import { NextRequest, NextResponse } from "next/server";
import {
  buildGraph,
  escapeHatch,
  explainNoStall,
  findStall,
  type Coverage,
  type Extraction,
} from "@/lib/pipeline";

/**
 * Coverage is user-supplied, so every field is coerced rather than trusted:
 * a malformed `coverage` degrades to "no cover declared" (the escalation-only
 * path) instead of failing an otherwise valid graph request.
 */
function normalizeCoverage(raw: unknown): Coverage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const plan = typeof c.plan_type === "string" ? c.plan_type.trim() : "";
  const confidence = typeof c.confidence === "number" && Number.isFinite(c.confidence)
    ? Math.min(1, Math.max(0, c.confidence))
    : 0;
  return {
    plan_type: plan || null,
    covers_diagnostics: c.covers_diagnostics === true,
    covers_consults: c.covers_consults === true,
    requires_gp_referral: c.requires_gp_referral === true,
    requires_preauth: c.requires_preauth === true,
    excludes: Array.isArray(c.excludes)
      ? c.excludes.filter((e): e is string => typeof e === "string")
      : [],
    confidence,
  };
}

/**
 * POST /api/graph — build the deterministic cross-department graph.
 * Body: { extractions: Extraction[], asOf?: "YYYY-MM-DD", coverage?: Coverage }
 *
 * `coverage` is optional and additive: omit it and the response is the graph and
 * stall exactly as before, with `escapeHatch: null`. The escape hatch is only
 * ever evaluated for the single stalled bottleneck node.
 */
export function POST(req: NextRequest) {
  return req.json().then((body: { extractions?: Extraction[]; asOf?: string; coverage?: unknown }) => {
    if (!Array.isArray(body.extractions)) {
      return NextResponse.json({ error: "extractions must be an array" }, { status: 400 });
    }
    const graph = buildGraph(body.extractions, body.asOf);
    const stall = findStall(graph, body.asOf);
    const coverage = body.coverage === undefined ? null : normalizeCoverage(body.coverage);
    // escapeHatch() itself is non-null for a not-coverable stall too (coverable:
    // false, with the reason) — null here means only "nothing was declared".
    const hatch = stall && coverage ? escapeHatch(stall, coverage) : null;
    // A bare null stall reads as "not computed". Say which of the three it is.
    const noStallReason = stall ? null : explainNoStall(graph, body.asOf);
    return NextResponse.json({ graph, stall, noStallReason, escapeHatch: hatch });
  }).catch((err: unknown) =>
    NextResponse.json(
      { error: err instanceof Error ? err.message : "graph failed" },
      { status: 400 },
    ),
  );
}
