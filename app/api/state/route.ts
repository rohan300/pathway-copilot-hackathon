import { NextRequest, NextResponse } from "next/server";
import { runStateMachine, type Extraction } from "@/lib/pipeline";

/**
 * POST /api/state — run the deterministic state machine.
 * Body: { extractions: Extraction[], asOf?: "YYYY-MM-DD" }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { extractions?: Extraction[]; asOf?: string };
    if (!Array.isArray(body.extractions)) {
      return NextResponse.json({ error: "extractions must be an array" }, { status: 400 });
    }
    const result = runStateMachine(body.extractions, body.asOf);
    return NextResponse.json({ state: result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "state failed" },
      { status: 400 },
    );
  }
}
