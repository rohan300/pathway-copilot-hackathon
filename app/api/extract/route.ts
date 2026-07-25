import { NextRequest, NextResponse } from "next/server";
import { extractLetter, ExtractionError, type ExtractInput } from "@/lib/pipeline";
import {
  extractPdfText,
  isPdf,
  looksLikeText,
  rasterizePdf,
  PdfRasterizeError,
  RASTERIZE_MAX_PAGES,
} from "@/lib/pdf";

// pdf-parse and the PDF rasterizer run in the Node runtime (not edge).
export const runtime = "nodejs";

/** Rendering several pages at 150 DPI takes longer than the default budget. */
export const maxDuration = 60;

/**
 * POST /api/extract — extract one NHS letter into strict JSON.
 *
 * Accepts either:
 *  - application/json: { sampleId?, text?, imageBase64? }
 *  - multipart/form-data: file (PDF or image), or a `text` field, or `sampleId`
 *
 * PDFs: text-based PDFs are read server-side and passed as text (no vision cost).
 * Scanned/image-only PDFs (little extractable text) are rasterized page by page
 * and sent as images, because the provider's image_url part rejects a raw PDF.
 *
 * Failures are never silent: a provider or render error answers non-200 with a
 * readable message so the UI can show it (GLD-11).
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
            // Text-based PDF: cheapest, most reliable path. No vision tokens.
            input.text = pdfText;
          } else {
            // Scanned/image-only PDF: render the pages so the vision model gets
            // real images. Capped to bound cost on long letters.
            const { pages, totalPages } = await rasterizePdf(buf, {
              maxPages: RASTERIZE_MAX_PAGES,
            });
            input.images = pages.map((page) => ({ base64: page.base64, mime: page.mime }));
            input.imagesNote =
              pages.length < totalPages
                ? `Scanned letter. You are seeing pages 1-${pages.length} of ${totalPages}; later pages were not supplied.`
                : `Scanned letter, ${pages.length} page image(s) in order.`;
          }
        } else {
          input.images = [{
            base64: buf.toString("base64"),
            mime: mime.startsWith("image/") ? mime : "image/png",
          }];
        }
      }
    } else {
      const body = (await req.json()) as ExtractInput & {
        imageBase64?: string;
        imageMime?: string;
      };
      if (body.sampleId) input.sampleId = body.sampleId;
      if (body.text) input.text = body.text;
      if (Array.isArray(body.images) && body.images.length) input.images = body.images;
      else if (body.imageBase64) {
        input.images = [{ base64: body.imageBase64, mime: body.imageMime || "image/png" }];
      }
    }

    const extraction = await extractLetter(input);
    return NextResponse.json({ extraction });
  } catch (err) {
    if (err instanceof ExtractionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof PdfRasterizeError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "extract failed" },
      { status: 400 },
    );
  }
}
