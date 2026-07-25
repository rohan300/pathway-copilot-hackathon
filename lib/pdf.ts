/**
 * PDF letter ingestion.
 *
 * Most uploaded NHS letters are text-based PDFs, so we extract their text
 * server-side and feed it to the Extractor exactly like pasted text — no LLM
 * vision cost. Scanned/image-only PDFs yield little or no text; the caller
 * detects that (via `looksLikeText`) and falls back to the vision path.
 *
 * We import pdf-parse's inner module directly to skip its index.js debug harness
 * (which reads a bundled test file on import and throws under a bundler).
 */
// @ts-expect-error - pdf-parse ships no types; the inner module returns { text }.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

/** Extract text from a PDF buffer. Returns "" if parsing fails. */
export async function extractPdfText(buf: Buffer): Promise<string> {
  try {
    const data = (await pdfParse(buf)) as { text?: string };
    return (data.text || "").trim();
  } catch {
    return "";
  }
}

/**
 * Heuristic: is there enough extracted text to treat this as a text-based PDF?
 * Scanned PDFs typically return empty or a handful of stray characters.
 */
export function looksLikeText(text: string): boolean {
  return text.replace(/\s+/g, "").length >= 40;
}

/** True when the uploaded file is a PDF (by mime or extension). */
export function isPdf(mime: string, name: string): boolean {
  return (
    mime === "application/pdf" || name.toLowerCase().endsWith(".pdf")
  );
}
