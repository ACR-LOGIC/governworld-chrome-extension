// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Image-page loading for single-image documents. Runs inside the offscreen
 * document (DOM canvas available).
 */
import type { OcrToken } from "./ocr.js";

export interface ImagePage {
  index: number;
  canvas: HTMLCanvasElement;
  widthPx: number;
  heightPx: number;
  widthPt: number;
  heightPt: number;
  hasTextLayer: boolean;
  /**
   * Always null: an image has no embedded text, so OCR is the only way to read
   * it. The field exists so every page source has the same shape.
   */
  tokens: OcrToken[] | null;
}

const MAX_IMAGE_PIXELS = 24_000_000; // ~ 5.5k x 4.3k

/**
 * Pixels are converted to points at 96 DPI, the CSS reference resolution, so a
 * 1240x1754 image becomes a 9.3x13.2 inch sheet.
 *
 * These used to be 0, which is not a valid page size anywhere downstream: the
 * print view sizes its sheet from these numbers, and it rejected every image
 * document as malformed. An image has no intrinsic PDF point geometry, so one
 * has to be chosen, and 96 DPI is the one that matches how the browser itself
 * treats image pixels as a physical size.
 */
const IMAGE_DPI = 96;
const PX_TO_PT = 72 / IMAGE_DPI;

export async function loadImagePage(bytes: ArrayBuffer): Promise<ImagePage> {
  const blob = new Blob([bytes]);
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / (bitmap.width * bitmap.height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
    canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas rendering is unavailable.");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return {
      index: 0,
      canvas,
      widthPx: canvas.width,
      heightPx: canvas.height,
      widthPt: canvas.width * PX_TO_PT,
      heightPt: canvas.height * PX_TO_PT,
      hasTextLayer: false,
      tokens: null,
    };
  } finally {
    bitmap.close();
  }
}