// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Image-page loading for single-image documents. Runs inside the offscreen
 * document (DOM canvas available).
 */

export interface ImagePage {
  index: number;
  canvas: HTMLCanvasElement;
  widthPx: number;
  heightPx: number;
  widthPt: number;
  heightPt: number;
  hasTextLayer: boolean;
}

const MAX_IMAGE_PIXELS = 24_000_000; // ~ 5.5k x 4.3k

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
      widthPt: 0,
      heightPt: 0,
      hasTextLayer: false,
    };
  } finally {
    bitmap.close();
  }
}