/**
 * Both upload branches end-to-end through the route, on synthetic fixtures.
 *
 * The provider is stubbed so the assertions are about what we send it: a text
 * PDF must cost no vision tokens, a scanned PDF must arrive as real page images
 * (never a data:application/pdf URL), and a provider failure must surface as a
 * non-200 with a readable message instead of an empty extraction at 200.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeScannedPdf, makeTextPdf } from "@/lib/pdf.fixtures";

const provider = {
  hasKey: true,
  create: vi.fn(),
};

vi.mock("@/lib/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provider")>();
  return {
    ...actual,
    get hasLLMKey() {
      return provider.hasKey;
    },
    getLLM: () =>
      provider.hasKey
        ? { chat: { completions: { create: provider.create } } }
        : null,
  };
});

const { POST } = await import("./route");

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

const LETTER_LINES = [
  "Gastroenterology Clinic Letter",
  "Letter creation date: 06-FEB-2026",
  "I have requested a chest x-ray.",
];

const MODEL_JSON = JSON.stringify({
  letter_date: "2026-02-06",
  department: "Gastroenterology",
  clinicians: [{ name: "Dr Simon Peake", dept: "Gastroenterology" }],
  investigations: [
    {
      id: "cxr",
      name: "Chest X-ray",
      type: "xray",
      ordered_date: "2026-02-06",
      report_date: null,
      status: "ordered",
    },
  ],
  findings: [],
  referrals: [],
  dependencies: [],
  mdt: [],
  confidence: 0.8,
});

function upload(file: Buffer, name: string, type = "application/pdf"): Request {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(file)], name, { type }));
  return new Request("http://localhost/api/extract", { method: "POST", body: form });
}

/** The content parts of the single user message we sent the provider. */
function sentParts(): ContentPart[] {
  const call = provider.create.mock.calls.at(-1)?.[0];
  return call.messages.find((m: { role: string }) => m.role === "user").content;
}

beforeEach(() => {
  provider.hasKey = true;
  provider.create.mockReset();
  provider.create.mockResolvedValue({
    choices: [{ message: { content: MODEL_JSON } }],
  });
});

describe("POST /api/extract — text-based PDF", () => {
  it("sends the extracted text and no images at all", async () => {
    const res = await POST(upload(makeTextPdf(LETTER_LINES), "referral.pdf") as never);

    expect(res.status).toBe(200);
    const parts = sentParts();
    expect(parts.every((part) => part.type === "text")).toBe(true);
    expect((parts[0] as { text: string }).text).toContain("Gastroenterology Clinic Letter");

    const { extraction } = await res.json();
    expect(extraction.department).toBe("Gastroenterology");
    expect(extraction.investigations).toHaveLength(1);
  });
});

describe("POST /api/extract — scanned/image-only PDF", () => {
  it("rasterizes each page into an image part and never sends the raw PDF", async () => {
    const pdf = await makeScannedPdf([LETTER_LINES, ["Page two of the letter"]]);

    const res = await POST(upload(pdf, "clinic letter.pdf") as never);

    expect(res.status).toBe(200);
    const images = sentParts().filter((part) => part.type === "image_url");
    expect(images).toHaveLength(2);
    for (const image of images) {
      const url = (image as { image_url: { url: string } }).image_url.url;
      expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(url).not.toContain("application/pdf");
    }
  });

  it("caps the pages it sends and tells the model it saw a prefix", async () => {
    const pdf = await makeScannedPdf(
      Array.from({ length: 7 }, (_, index) => [`Page ${index + 1}`]),
    );

    await POST(upload(pdf, "long letter.pdf") as never);

    const parts = sentParts();
    expect(parts.filter((part) => part.type === "image_url")).toHaveLength(5);
    expect(
      parts.some(
        (part) => part.type === "text" && part.text.includes("pages 1-5 of 7"),
      ),
    ).toBe(true);
  });
});

describe("POST /api/extract — failures are never silent", () => {
  it("answers 502 with a readable message when the provider rejects the request", async () => {
    provider.create.mockRejectedValue(
      Object.assign(new Error("invalidRequest"), { status: 400 }),
    );

    const res = await POST(
      upload(await makeScannedPdf([LETTER_LINES]), "clinic letter.pdf") as never,
    );

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("invalidRequest");
  });

  it("answers 502 when the model returns nothing parseable", async () => {
    provider.create.mockResolvedValue({ choices: [{ message: { content: "sorry!" } }] });

    const res = await POST(upload(makeTextPdf(LETTER_LINES), "referral.pdf") as never);

    expect(res.status).toBe(502);
  });

  it("refuses a PDF data URL handed straight to the image path", async () => {
    const res = await POST(
      new Request("http://localhost/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          imageBase64: "JVBERi0xLjQK",
          imageMime: "application/pdf",
        }),
      }) as never,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("application/pdf");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("answers 422 when the PDF cannot be rendered at all", async () => {
    const res = await POST(upload(Buffer.from("%PDF-1.4 broken"), "broken.pdf") as never);

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/PDF/);
  });

  it("says so when a scanned letter needs vision but no key is configured", async () => {
    provider.hasKey = false;

    const res = await POST(
      upload(await makeScannedPdf([LETTER_LINES]), "clinic letter.pdf") as never,
    );

    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("no LLM key");
  });
});
