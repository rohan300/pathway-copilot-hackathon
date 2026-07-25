/**
 * The two PDF shapes an upload can be, on synthetic fixtures (real letters are
 * patient data): a text PDF that reads back as text, and a scanned/image-only
 * PDF that reads back as nothing and has to be rasterized.
 */

import { describe, expect, it } from "vitest";
import {
  extractPdfText,
  isPdf,
  looksLikeText,
  rasterizePdf,
  PdfRasterizeError,
} from "./pdf";
import { makeScannedPdf, makeTextPdf } from "./pdf.fixtures";

const LETTER_LINES = [
  "Gastroenterology Clinic Letter",
  "Letter creation date: 06-FEB-2026",
  "We will do his prebiological screening blood test today",
  "and I have requested a chest x-ray.",
];

describe("isPdf", () => {
  it("recognizes a PDF by mime or by extension", () => {
    expect(isPdf("application/pdf", "letter.bin")).toBe(true);
    expect(isPdf("application/octet-stream", "Clinic Letter.PDF")).toBe(true);
    expect(isPdf("image/png", "scan.png")).toBe(false);
  });
});

describe("extractPdfText", () => {
  it("reads the text of a text-based PDF", async () => {
    const text = await extractPdfText(makeTextPdf(LETTER_LINES));

    expect(text).toContain("Gastroenterology Clinic Letter");
    expect(text).toContain("chest x-ray");
    expect(looksLikeText(text)).toBe(true);
  });

  it("finds no text in a scanned/image-only PDF", async () => {
    const text = await extractPdfText(await makeScannedPdf([LETTER_LINES]));

    expect(text).toBe("");
    expect(looksLikeText(text)).toBe(false);
  });

  it("returns empty rather than throwing on a non-PDF buffer", async () => {
    expect(await extractPdfText(Buffer.from("not a pdf"))).toBe("");
  });
});

describe("rasterizePdf", () => {
  it("renders every page of a scanned PDF to a JPEG image", async () => {
    const pdf = await makeScannedPdf([LETTER_LINES, ["Page two"]]);

    const { pages, totalPages } = await rasterizePdf(pdf);

    expect(totalPages).toBe(2);
    expect(pages.map((page) => page.page)).toEqual([1, 2]);
    for (const page of pages) {
      expect(page.mime).toBe("image/jpeg");
      // A rendered A4-ish page at 150 DPI is never a couple of bytes.
      expect(page.base64.length).toBeGreaterThan(1000);
      // JPEG magic (0xFF 0xD8 0xFF) survives the base64 round-trip.
      expect(Buffer.from(page.base64, "base64").subarray(0, 3)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
    }
  });

  it("caps the pages it renders so a long letter cannot run up vision cost", async () => {
    const pdf = await makeScannedPdf([["one"], ["two"], ["three"], ["four"]]);

    const { pages, totalPages } = await rasterizePdf(pdf, { maxPages: 2 });

    expect(totalPages).toBe(4);
    expect(pages).toHaveLength(2);
  });

  it("scales the rendered image with the requested DPI", async () => {
    const pdf = await makeScannedPdf([LETTER_LINES]);

    const low = await rasterizePdf(pdf, { dpi: 72 });
    const high = await rasterizePdf(pdf, { dpi: 150 });

    expect(high.pages[0].base64.length).toBeGreaterThan(low.pages[0].base64.length);
  });

  it("throws a readable error instead of returning nothing for an unreadable file", async () => {
    await expect(rasterizePdf(Buffer.from("definitely not a pdf"))).rejects.toBeInstanceOf(
      PdfRasterizeError,
    );
  });
});
