import { NextRequest, NextResponse } from "next/server";
import { draft, type DraftInput, type DraftTarget } from "@/lib/pipeline";

const TARGETS: DraftTarget[] = [
  "advice_line",
  "pals",
  "clinician_summary",
  "insurer_preauth",
  "nhs_private_notice",
];

/** Private-route targets need a coverable escapeHatch from /api/graph. */
const PRIVATE_TARGETS: DraftTarget[] = ["insurer_preauth", "nhs_private_notice"];

/**
 * POST /api/draft — draft an administrative escalation.
 * Body: { stall, vitals?, target, escapeHatch?, meta? } (see DraftInput).
 *
 * The private-route targets additionally require `escapeHatch` and reject a
 * non-coverable one with 422 — a private-route letter is never drafted for a
 * step the deterministic coverage matcher ruled out.
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
    if (PRIVATE_TARGETS.includes(body.target)) {
      if (!body.escapeHatch) {
        return NextResponse.json(
          { error: `target ${body.target} requires escapeHatch` },
          { status: 400 },
        );
      }
      if (!body.escapeHatch.coverable) {
        return NextResponse.json(
          {
            error: "this step cannot be routed privately",
            reason: body.escapeHatch.reason,
          },
          { status: 422 },
        );
      }
    }
    const result = await draft({
      stall: body.stall,
      vitals: body.vitals ?? null,
      target: body.target,
      escapeHatch: body.escapeHatch ?? null,
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
