// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import * as pdfjsLib from "pdfjs-dist";

/**
 * PDF rendering to canvases using pdf.js in the extension context.
 * The worker is a bundled asset loaded via chrome.runtime.getURL so the
 * pipeline stays fully offline in local mode (no CDN / worker fetch).
 */

export interface RenderedPage {
  index: number;
  canvas: HTMLCanvasElement;
  widthPx: number;
  heightPx: number;
  /** Page size in PDF points (for faithful reassembly). */
  widthPt: number;
  heightPt: number;
  /** True when the page carries a native text layer. */
  hasTextLayer: boolean;
}

const MAX_PIXELS_PER_PAGE = 16_000_000; // ~ 4000x4000
const MAX_TOTAL_PIXELS = 64_000_000;

export function configurePdfWorker(): void {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("assets/pdf.worker.min.mjs");
}

export async function renderPdfPages(
  data: ArrayBuffer,
  maxPages: number,
  dpi = 150
): Promise<RenderedPage[]> {
  configurePdfWorker();
  // `isEvalSupported` is gone in pdf.js 6: the library no longer compiles
  // anything at runtime, so the flag that used to disable it no longer exists.
  // Passing it is a type error, and its absence is the stronger guarantee.
  const loadingTask = pdfjsLib.getDocument({ data, useSystemFonts: true });
  const pdf = await loadingTask.promise;

  try {
    const total = pdf.numPages;
    const pagesToRender = Math.min(total, maxPages);
    const out: RenderedPage[] = [];
    let totalPixels = 0;

    const baseScale = dpi / 72; // 72 points per inch
    for (let i = 1; i <= pagesToRender; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      let viewport = page.getViewport({ scale: baseScale });

      // Constrain total rendered pixels.
      let pixels = viewport.width * viewport.height;
      if (pixels > MAX_PIXELS_PER_PAGE) {
        const factor = Math.sqrt(MAX_PIXELS_PER_PAGE / pixels);
        viewport = page.getViewport({ scale: baseScale * factor });
        pixels = viewport.width * viewport.height;
      }

      totalPixels += pixels;
      if (totalPixels > MAX_TOTAL_PIXELS) {
        throw new Error("Document is too large to process on this device.");
      }

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Canvas rendering is unavailable.");

      // pdf.js 6 requires `canvas` on the render parameters; `canvasContext` is
      // the legacy form and must not be passed unless the canvas is null.
      await page.render({ canvas, viewport, intent: "print" }).promise;

      let hasTextLayer = false;
      try {
        const textContent = await page.getTextContent();
        hasTextLayer = textContent.items.length > 0;
      } catch {
        hasTextLayer = false;
      }
      out.push({
        index: i - 1,
        canvas,
        widthPx: canvas.width,
        heightPx: canvas.height,
        widthPt: base.width,
        heightPt: base.height,
        hasTextLayer,
      });
    }
    return out;
  } finally {
    // Teardown moved to the loading task in pdf.js 6, and it also tears the
    // worker down. `PDFDocumentProxy.destroy()` no longer exists, so the old
    // call left the worker alive for the life of the document.
    await loadingTask.destroy().catch(() => undefined);
  }
}