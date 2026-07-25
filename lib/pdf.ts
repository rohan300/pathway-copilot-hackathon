/**
 * PDF letter ingestion.
 *
 * Most uploaded NHS letters are text-based PDFs, so we extract their text
 * server-side and feed it to the Extractor exactly like pasted text — no LLM
 * vision cost. Scanned/image-only PDFs yield little or no text; the caller
 * detects that (via `looksLikeText`) and rasterizes the pages instead, because
 * the provider's `image_url` content part only accepts real images — handing it
 * a `data:application/pdf` URL is a 400 (invalidRequest).
 *
 * We import pdf-parse's inner module directly to skip its index.js debug harness
 * (which reads a bundled test file on import and throws under a bundler).
 */
// @ts-expect-error - pdf-parse ships no types; the inner module returns { text }.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

/**
 * Extract text from a PDF buffer. Returns "" if parsing fails.
 *
 * Handed a Node Buffer, pdf-parse's bundled pdf.js re-wraps it with
 * `new Buffer(buf)` — which for anything under ~4 KB lands in Node's shared
 * buffer pool at a non-zero byteOffset that pdf.js then ignores, so every xref
 * offset is wrong and a small PDF reads as empty. A plain Uint8Array always
 * gets its own backing store, so pass one.
 */
export async function extractPdfText(buf: Buffer): Promise<string> {
  try {
    const data = (await pdfParse(new Uint8Array(buf))) as { text?: string };
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

/** One rasterized page, ready to become an `image_url` content part. */
export interface PdfPageImage {
  /** 1-based page number in the source PDF. */
  page: number;
  base64: string;
  /** Always a real image mime — never application/pdf. */
  mime: string;
}

export interface RasterizeResult {
  pages: PdfPageImage[];
  /** Pages in the source PDF, so the caller can tell the model it saw a prefix. */
  totalPages: number;
}

export interface RasterizeOptions {
  /** Render resolution. 150 keeps NHS body text legible without ballooning cost. */
  dpi?: number;
  /** Hard cap on pages sent to the model, to bound vision spend. */
  maxPages?: number;
  /** JPEG quality, 1-100. */
  quality?: number;
}

export const RASTERIZE_DPI = 150;
export const RASTERIZE_MAX_PAGES = 5;
const RASTERIZE_QUALITY = 80;

/** Thrown when a PDF cannot be rendered at all — never swallowed into an empty result. */
export class PdfRasterizeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfRasterizeError";
  }
}

/**
 * Render the first `maxPages` pages of a PDF to JPEG images.
 *
 * pdfjs-dist installs the browser globals it needs (`Path2D`, `DOMMatrix`,
 * `ImageData`) from its own copy of @napi-rs/canvas, and then type-checks the
 * objects it is handed against those classes. Our @napi-rs/canvas range must
 * therefore stay aligned with pdfjs-dist's, so npm resolves ONE copy — two
 * copies means two `Path2D` classes and every render fails with
 * "Value is none of these types `String`, `Path`".
 *
 * Both packages are prebuilt and Node-runtime only, imported lazily so the
 * text-PDF path never pays for loading them.
 */
export async function rasterizePdf(
  buf: Buffer,
  options: RasterizeOptions = {},
): Promise<RasterizeResult> {
  const dpi = options.dpi ?? RASTERIZE_DPI;
  const maxPages = options.maxPages ?? RASTERIZE_MAX_PAGES;
  const quality = options.quality ?? RASTERIZE_QUALITY;

  const canvasLib = await import("@napi-rs/canvas");
  // The legacy build is the one that runs outside a browser.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
    }).promise;
  } catch (err) {
    throw new PdfRasterizeError(
      `Could not open the PDF for rendering: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  try {
    const pages: PdfPageImage[] = [];
    const count = Math.min(doc.numPages, maxPages);
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: dpi / 72 });
      const canvas = canvasLib.createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      const ctx = canvas.getContext("2d");
      // Scanned pages carry no background of their own; without this the
      // transparent canvas flattens to black and the text is unreadable.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // pdfjs types the render target as the DOM canvas; @napi-rs/canvas is the
      // same surface without the DOM event machinery, so the cast is the seam.
      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
        canvas: canvas as unknown as HTMLCanvasElement,
      }).promise;
      page.cleanup();
      pages.push({
        page: n,
        base64: canvas.toBuffer("image/jpeg", quality).toString("base64"),
        mime: "image/jpeg",
      });
    }
    if (pages.length === 0) {
      throw new PdfRasterizeError("The PDF has no pages to render.");
    }
    return { pages, totalPages: doc.numPages };
  } catch (err) {
    if (err instanceof PdfRasterizeError) throw err;
    throw new PdfRasterizeError(
      `Could not render the PDF pages: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    await doc.destroy();
  }
}
