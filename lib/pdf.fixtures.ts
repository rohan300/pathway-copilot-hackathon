/**
 * Synthetic PDF fixtures for tests.
 *
 * Real NHS letters are patient data and never enter the repo, so the two shapes
 * that matter are generated instead: a text-based PDF (extractable text, no
 * vision cost) and a scanned/image-only PDF (zero extractable text, must be
 * rasterized). Both are written by hand — a minimal PDF is a handful of objects
 * plus a cross-reference table, which is cheaper than another dependency.
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/**
 * Assemble numbered PDF objects into a valid file, computing the xref offsets.
 * `bodies` is 1-indexed by position: bodies[0] becomes object `1 0 obj`.
 */
function buildPdf(bodies: (string | Buffer)[]): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let offset = chunks[0].length;

  bodies.forEach((body, index) => {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      typeof body === "string" ? Buffer.from(body) : body,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  });

  const xrefLines = [
    `xref\n0 ${bodies.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`),
  ].join("");
  chunks.push(
    Buffer.from(
      `${xrefLines}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

/** A stream object with the correct /Length. */
function streamObject(dict: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`),
    data,
    Buffer.from("\nendstream"),
  ]);
}

/** Escape the characters that would otherwise end a PDF string literal. */
function pdfString(value: string): string {
  return value.replace(/([\\()])/g, "\\$1");
}

/**
 * A text-based PDF: real Helvetica text operators, so pdf-parse reads it back
 * and the extractor never touches the vision path.
 */
export function makeTextPdf(lines: string[]): Buffer {
  const body = [
    "BT",
    "/F1 12 Tf",
    "14 TL",
    `1 0 0 1 60 ${PAGE_HEIGHT - 60} Tm`,
    ...lines.map((line) => `(${pdfString(line)}) Tj T*`),
    "ET",
  ].join("\n");

  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    streamObject("", Buffer.from(body)),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

/**
 * A scanned/image-only PDF: each page is one full-bleed JPEG and nothing else,
 * so `extractPdfText` returns "" exactly like the real scanned letters do.
 * The page text is drawn into the image, so a rasterized render is legible.
 */
export async function makeScannedPdf(
  pagesOfLines: string[][],
): Promise<Buffer> {
  const { createCanvas } = await import("@napi-rs/canvas");

  const jpegs = pagesOfLines.map((lines) => {
    const canvas = createCanvas(PAGE_WIDTH * 2, PAGE_HEIGHT * 2);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    ctx.font = "28px sans-serif";
    lines.forEach((line, index) => ctx.fillText(line, 80, 120 + index * 44));
    return canvas.toBuffer("image/jpeg", 90);
  });

  // Object layout: 1 catalog, 2 pages, then per page a /Page, its content
  // stream and its image XObject.
  const firstPageObject = 3;
  const kids = jpegs
    .map((_, index) => `${firstPageObject + index * 3} 0 R`)
    .join(" ");

  const bodies: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${jpegs.length} >>`,
  ];

  jpegs.forEach((jpeg, index) => {
    const pageObj = firstPageObject + index * 3;
    const contentObj = pageObj + 1;
    const imageObj = pageObj + 2;
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>`,
    );
    bodies.push(
      streamObject(
        "",
        Buffer.from(`q ${PAGE_WIDTH} 0 0 ${PAGE_HEIGHT} 0 0 cm /Im0 Do Q`),
      ),
    );
    bodies.push(
      streamObject(
        "/Type /XObject /Subtype /Image " +
          `/Width ${PAGE_WIDTH * 2} /Height ${PAGE_HEIGHT * 2} ` +
          "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
        jpeg,
      ),
    );
  });

  return buildPdf(bodies);
}
