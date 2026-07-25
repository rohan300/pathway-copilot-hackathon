import { NextRequest, NextResponse } from "next/server";
import { buildGraph, findStall, type Extraction } from "@/lib/pipeline";

/**
 * POST /api/graph — build the deterministic cross-department graph.
 * Body: { extractions: Extraction[], asOf?: "YYYY-MM-DD" }
 */
export function POST(req: NextRequest) {
  return req.json().then((body: { extractions?: Extraction[]; asOf?: string }) => {
    if (!Array.isArray(body.extractions)) {
      return NextResponse.json({ error: "extractions must be an array" }, { status: 400 });
    }
    const graph = buildGraph(body.extractions);
    const stall = findStall(graph, body.asOf);
    return NextResponse.json({ graph, stall });
  }).catch((err: unknown) =>
    NextResponse.json(
      { error: err instanceof Error ? err.message : "graph failed" },
      { status: 400 },
    ),
  );
}
