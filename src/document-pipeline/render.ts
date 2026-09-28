// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { PDFDocument } from "pdf-lib";
import type { Rect, RedactionOptions } from "../shared/types.js";

/**
 * Flattening: redaction is irreversible. Boxes are painted onto the rasterized
 * page pixels before the output is produced, so underlying text cannot be
 * recovered from the output (there is no reversible overlay object).
 */

const DEFAULT_PADDING = 4;

export function applyBoxes(
  canvas: HTMLCanvasElement,
  boxes: Rect[],
  paddingOrOptions: number | RedactionOptions = DEFAULT_PADDING,
  options?: RedactionOptions
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas rendering is unavailable.");

  let padding = DEFAULT_PADDING;
  let opts: RedactionOptions = {};

  if (typeof paddingOrOptions === "number") {
    padding = paddingOrOptions;
    if (options) opts = options;
  } else if (typeof paddingOrOptions === "object" && paddingOrOptions !== null) {
    opts = paddingOrOptions;
    padding = typeof opts.padding === "number" ? opts.padding : DEFAULT_PADDING;
  }

  const style = opts.style ?? "blackout";
  const fillColor = opts.fillColor ?? (style === "whiteout" ? "#ffffff" : "#000000");
  const stampText = style === "stamp" ? (opts.stampText ?? "[REDACTED]") : opts.stampText;

  for (const box of boxes) {
    const x = Math.max(0, box.x - padding);
    const y = Math.max(0, box.y - padding);
    const w = Math.min(canvas.width - x, box.width + padding * 2);
    const h = Math.min(canvas.height - y, box.height + padding * 2);
    if (w <= 0 || h <= 0) continue;

    ctx.fillStyle = fillColor;
    ctx.fillRect(x, y, w, h);

    if (stampText) {
      ctx.save();
      const textColor = fillColor.toLowerCase() === "#ffffff" ? "#000000" : "#ffffff";
      ctx.fillStyle = textColor;
      const fontSize = Math.max(8, Math.min(Math.floor(h * 0.7), Math.floor((w / Math.max(1, stampText.length)) * 1.5), 16));
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(stampText, x + w / 2, y + h / 2);
      ctx.restore();
    }
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