import { NextRequest, NextResponse } from "next/server";
import { extractLetter, type ExtractInput } from "@/lib/pipeline";
import { extractPdfText, isPdf, looksLikeText } from "@/lib/pdf";

// pdf-parse runs in the Node runtime (not edge).
export const runtime = "nodejs";

/**
 * POST /api/extract — extract one NHS letter into strict JSON.
 *
 * Accepts either:
 *  - application/json: { sampleId?, text?, imageBase64? }
 *  - multipart/form-data: file (PDF or image), or a `text` field, or `sampleId`
 *
 * PDFs: text-based PDFs are read server-side and passed as text (no vision cost).
 * Scanned/image-only PDFs (little extractable text) fall back to the vision path
 * so a vision-capable model can still read them.
 */
export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    const input: ExtractInput = {};

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const sampleId = form.get("sampleId");
      const text = form.get("text");
      const file = form.get("file");
      if (typeof sampleId === "string" && sampleId) input.sampleId = sampleId;
      if (typeof text === "string" && text) input.text = text;
      if (file && file instanceof File) {
        const buf = Buffer.from(await file.arrayBuffer());
        const mime = file.type || "application/octet-stream";
        if (isPdf(mime, file.name)) {
          const pdfText = await extractPdfText(buf);
          if (looksLikeText(pdfText)) {
            // Text-based PDF: cheapest, most reliable path.
            input.text = pdfText;
          } else {
            // Scanned/image PDF: hand the raw PDF to a vision-capable model.
            input.imageBase64 = buf.toString("base64");
            input.imageMime = "application/pdf";
          }
        } else {
          input.imageBase64 = buf.toString("base64");
          input.imageMime = mime.startsWith("image/") ? mime : "image/png";
        }
      }
    } else {
      const body = (await req.json()) as ExtractInput;
      if (body.sampleId) input.sampleId = body.sampleId;
      if (body.text) input.text = body.text;
      if (body.imageBase64) {
        input.imageBase64 = body.imageBase64;
        input.imageMime = body.imageMime;
      }
    }

    const extraction = await extractLetter(input);
    return NextResponse.json({ extraction });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "extract failed" },
      { status: 400 },
    );
  }
}
