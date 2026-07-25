import { NextRequest, NextResponse } from "next/server";
import { joinVitals } from "@/lib/pipeline";

/**
 * POST /api/vitals — join a Fitbit CSV against the pathway start date.
 *
 * Accepts either:
 *  - application/json: { csv: string, startDate: "YYYY-MM-DD" }
 *  - multipart/form-data: file (CSV) + startDate field
 */
export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    let csv = "";
    let startDate = "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const sd = form.get("startDate");
      if (file && file instanceof File) csv = await file.text();
      const csvField = form.get("csv");
      if (!csv && typeof csvField === "string") csv = csvField;
      if (typeof sd === "string") startDate = sd;
    } else {
      const body = (await req.json()) as { csv?: string; startDate?: string };
      csv = body.csv || "";
      startDate = body.startDate || "";
    }

    if (!csv || !startDate) {
      return NextResponse.json({ error: "csv and startDate are required" }, { status: 400 });
    }

    const result = joinVitals(csv, startDate);
    return NextResponse.json({ vitals: result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "vitals failed" },
      { status: 400 },
    );
  }
}
