import { NextRequest, NextResponse } from "next/server";
import { draft, type DraftInput, type DraftTarget } from "@/lib/pipeline";

const TARGETS: DraftTarget[] = ["advice_line", "pals", "clinician_summary"];

/**
 * POST /api/draft — draft an administrative escalation.
 * Body: { state, vitals?, target, meta? } (see DraftInput).
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<DraftInput>;
    if (!body.state) {
      return NextResponse.json({ error: "state is required" }, { status: 400 });
    }
    if (!body.target || !TARGETS.includes(body.target)) {
      return NextResponse.json(
        { error: `target must be one of ${TARGETS.join(", ")}` },
        { status: 400 },
      );
    }
    const result = await draft({
      state: body.state,
      vitals: body.vitals ?? null,
      target: body.target,
      meta: body.meta,
    });
    return NextResponse.json({ draft: result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "draft failed" },
      { status: 400 },
    );
  }
}
