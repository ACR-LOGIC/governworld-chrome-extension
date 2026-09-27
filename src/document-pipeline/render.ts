// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { PDFDocument, rgb } from "pdf-lib";
import type { Rect } from "../shared/types.js";

/**
 * Flattening: redaction is irreversible. Boxes are painted onto the rasterized
 * page pixels before the output is produced, so underlying text cannot be
 * recovered from the output (there is no reversible overlay object).
 */

const DEFAULT_PADDING = 4;
const BOX_COLOR = rgb(0, 0, 0);

export function applyBoxes(canvas: HTMLCanvasElement, boxes: Rect[], padding = DEFAULT_PADDING): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas rendering is unavailable.");
  ctx.fillStyle = "#000000";
  for (const box of boxes) {
    const x = Math.max(0, box.x - padding);
    const y = Math.max(0, box.y - padding);
    const w = Math.min(canvas.width - x, box.width + padding * 2);
    const h = Math.min(canvas.height - y, box.height + padding * 2);
    ctx.fillRect(x, y, w, h);
  }
}

export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode image"))), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Reassemble redacted pages into a single flattened PDF. Each redacted page is
 * embedded as an image covering its original page size (in points), so the
 * output has no extractable text — exactly what the rasterization path implies.
 */
export async function pagesToPdf(
  pages: { pngBytes: Uint8Array; widthPt: number; heightPt: number }[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const page of pages) {
    const pdfPage = doc.addPage([page.widthPt, page.heightPt]);
    const image = await doc.embedPng(page.pngBytes);
    pdfPage.drawImage(image, {
      x: 0,
      y: 0,
      width: page.widthPt,
      height: page.heightPt,
    });
  }
  return doc.save();
}

/** Coordinate mapping between OCR token boxes and the rendered canvas. */
export function scaleBox(box: Rect, scaleX: number, scaleY: number): Rect {
  return {
    x: box.x * scaleX,
    y: box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY,
  };
}