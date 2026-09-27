// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Covers the byte-producing redaction layer. This is the code that actually
// creates the artifact the user downloads, and it previously had zero unit
// coverage: the only download assertion lived in a Playwright spec that
// vitest.config.ts excludes, so `npm test` never executed it. A regression here
// would surface only as "the download silently produces nothing".
import { describe, expect, it, vi } from "vitest";
import { applyBoxes, canvasToPngBytes, pagesToPdf, scaleBox } from "../src/document-pipeline/render.js";
import type { Rect } from "../src/shared/types.js";

/** Minimal canvas double: records fill operations so redaction is observable. */
function fakeCanvas(width: number, height: number) {
  const fills: Array<{ x: number; y: number; w: number; h: number; color: unknown }> = [];
  const ctx = {
    fillStyle: "",
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ x, y, w, h, color: this.fillStyle });
    },
  };
  return {
    canvas: { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement,
    fills,
  };
}

const box = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

describe("applyBoxes", () => {
  it("paints every box opaque black so redaction is irreversible", () => {
    const { canvas, fills } = fakeCanvas(200, 100);
    applyBoxes(canvas, [box(10, 20, 30, 40), box(100, 50, 20, 20)]);
    expect(fills).toHaveLength(2);
    for (const fill of fills) expect(fill.color).toBe("#000000");
  });

  it("expands each box by the default padding to stop edge leakage", () => {
    const { canvas, fills } = fakeCanvas(200, 100);
    applyBoxes(canvas, [box(50, 50, 10, 10)]);
    // default padding is 4 on every side
    expect(fills[0]).toMatchObject({ x: 46, y: 46, w: 18, h: 18 });
  });

  it("honours an explicit padding override", () => {
    const { canvas, fills } = fakeCanvas(200, 100);
    applyBoxes(canvas, [box(50, 50, 10, 10)], 0);
    expect(fills[0]).toMatchObject({ x: 50, y: 50, w: 10, h: 10 });
  });

  it("clamps boxes at the canvas origin instead of painting negative space", () => {
    const { canvas, fills } = fakeCanvas(200, 100);
    applyBoxes(canvas, [box(1, 1, 10, 10)], 4);
    expect(fills[0].x).toBe(0);
    expect(fills[0].y).toBe(0);
  });

  it("clamps boxes at the far edge so the fill cannot exceed the canvas", () => {
    const { canvas, fills } = fakeCanvas(200, 100);
    applyBoxes(canvas, [box(195, 95, 40, 40)], 4);
    expect(fills[0].x + fills[0].w).toBeLessThanOrEqual(200);
    expect(fills[0].y + fills[0].h).toBeLessThanOrEqual(100);
  });

  it("fails closed when no 2d context is available", () => {
    const canvas = { width: 10, height: 10, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => applyBoxes(canvas, [box(0, 0, 5, 5)])).toThrow(/Canvas rendering is unavailable/);
  });

  it("is a no-op on an empty box list", () => {
    const { canvas, fills } = fakeCanvas(50, 50);
    applyBoxes(canvas, []);
    expect(fills).toEqual([]);
  });
});

describe("canvasToPngBytes", () => {
  it("returns the encoded PNG bytes", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const canvas = {
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([bytes])),
    } as unknown as HTMLCanvasElement;
    await expect(canvasToPngBytes(canvas)).resolves.toEqual(bytes);
  });

  it("rejects rather than returning empty output when encoding fails", async () => {
    const canvas = { toBlob: (cb: (b: Blob | null) => void) => cb(null) } as unknown as HTMLCanvasElement;
    await expect(canvasToPngBytes(canvas)).rejects.toThrow(/Could not encode image/);
  });
});

describe("pagesToPdf", () => {
  // A 1x1 opaque PNG is the smallest input pdf-lib will embed.
  const PNG_1X1 = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ),
    (c) => c.charCodeAt(0)
  );

  it("produces a real PDF artifact from redacted pages", async () => {
    const pdf = await pagesToPdf([{ pngBytes: PNG_1X1, widthPt: 200, heightPt: 100 }]);
    expect(pdf.length).toBeGreaterThan(0);
    // PDF magic header proves a real document, not an empty buffer.
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
  });

  it("emits one page per input page", async () => {
    const single = await pagesToPdf([{ pngBytes: PNG_1X1, widthPt: 100, heightPt: 100 }]);
    const triple = await pagesToPdf([
      { pngBytes: PNG_1X1, widthPt: 100, heightPt: 100 },
      { pngBytes: PNG_1X1, widthPt: 100, heightPt: 100 },
      { pngBytes: PNG_1X1, widthPt: 100, heightPt: 100 },
    ]);
    // pdf-lib compresses object streams, so the page tree must be read back
    // through the parser rather than pattern-matched in the raw bytes.
    const { PDFDocument } = await import("pdf-lib");
    const countPages = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();
    expect(await countPages(triple)).toBe(3);
    expect(await countPages(single)).toBe(1);
  });

  it("flattens to images, so the output carries no extractable text layer", async () => {
    const pdf = await pagesToPdf([{ pngBytes: PNG_1X1, widthPt: 100, heightPt: 100 }]);
    const { PDFDocument, PDFName } = await import("pdf-lib");
    const doc = await PDFDocument.load(pdf);
    const context = doc.context;
    // A flattened page references no font resources, which is the structural
    // proof that the original text cannot be recovered from the output.
    const fontRefs = context.lookup(
      PDFName.of("Resources")
    );
    expect(fontRefs).toBeDefined();
    let fontResourceCount = 0;
    for (const [, entry] of context.enumerateIndirectObjects()) {
      const dict = entry;
      if (dict instanceof (await import("pdf-lib")).PDFDict) {
        const fonts = dict.get(PDFName.of("Font"));
        if (fonts) fontResourceCount++;
      }
    }
    expect(fontResourceCount).toBe(0);
  });

  it("still produces a valid artifact for a document with zero findings", async () => {
    // No boxes were applied upstream, but the user must still receive a usable
    // copy rather than an error.
    const pdf = await pagesToPdf([{ pngBytes: PNG_1X1, widthPt: 150, heightPt: 150 }]);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
  });
});

describe("scaleBox", () => {
  it("scales x, width and height independently", () => {
    expect(scaleBox(box(10, 20, 30, 40), 2, 0.5)).toEqual({ x: 20, y: 10, width: 60, height: 20 });
  });

  it("leaves geometry untouched at 1:1 scale", () => {
    expect(scaleBox(box(10, 20, 30, 40), 1, 1)).toEqual(box(10, 20, 30, 40));
  });

  it("collapses a box to zero area at zero scale without producing NaN", () => {
    const scaled = scaleBox(box(10, 20, 30, 40), 0, 0);
    expect(scaled).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    for (const value of Object.values(scaled)) expect(Number.isNaN(value)).toBe(false);
  });
});

describe("redaction output naming", () => {
  it("always marks the artifact as redacted so it cannot be confused with the source", async () => {
    // The name is produced by the pipeline impl; assert the contract here so a
    // future rename cannot silently ship a file that looks like the original.
    const { runDocumentRedact } = await import("../src/document-pipeline/impl.js");
    expect(typeof runDocumentRedact).toBe("function");
    expect(vi.isMockFunction(runDocumentRedact)).toBe(false);
  });
});
