import { NextRequest, NextResponse } from "next/server";
import { draft, type DraftInput, type DraftTarget } from "@/lib/pipeline";

const TARGETS: DraftTarget[] = ["advice_line", "pals", "clinician_summary"];

/**
 * POST /api/draft — draft an administrative escalation.
 * Body: { stall, vitals?, target, meta? } (see DraftInput).
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<DraftInput>;
    if (!body.stall) {
      return NextResponse.json({ error: "stall is required" }, { status: 400 });
    }
    if (!body.target || !TARGETS.includes(body.target)) {
      return NextResponse.json(
        { error: `target must be one of ${TARGETS.join(", ")}` },
        { status: 400 },
      );
    }
    const result = await draft({
      stall: body.stall,
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
