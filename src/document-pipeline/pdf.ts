// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import * as pdfjsLib from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";
import type { OcrToken } from "./ocr.js";

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
  /**
   * Tokens read from the page's own text layer, in canvas pixels.
   *
   * Present only when the page really carries selectable text. A PDF that was
   * born digital has an exact copy of its text, and reading it beats OCR on
   * every axis that matters here: it is instantaneous, it never confuses `0`
   * with `O` or `1` with `l` (which is how an 11-digit card or a 9-digit SSN
   * stops matching and a real value ships unredacted), and its glyph boxes come
   * from the file rather than from a guess about pixels. Only a scanned page
   * needs OCR, and `null` here is the signal to fall back to it.
   */
  tokens: OcrToken[] | null;
}

const MAX_PIXELS_PER_PAGE = 16_000_000; // ~ 4000x4000
const MAX_TOTAL_PIXELS = 64_000_000;

/** Token ceiling, so a pathological text layer cannot grow unbounded. */
const MAX_TEXT_TOKENS = 20_000;

/**
 * Horizontal slack added to each token box, in canvas pixels.
 *
 * Glyph advance widths do not always sum to the item width the PDF reports
 * (kerning, ligatures, and a substituted font all move the edges). A redaction
 * box that stops a few pixels short leaves a readable fragment of the value on
 * the page, so boxes are widened rather than trimmed. The extra is proportional
 * to the line height so it stays negligible for small text and meaningful for
 * large headings.
 */
function horizontalSlack(fontHeight: number): number {
  return Math.max(1, fontHeight * 0.12);
}

export function configurePdfWorker(): void {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("assets/pdf.worker.min.mjs");
}

/**
 * Turn a page's text layer into tokens positioned in canvas pixels.
 *
 * The geometry follows pdf.js's own text layer rather than being re-derived:
 * `TextItem.transform` is a TEXT-SPACE matrix, so `width`/`height` are in text
 * units and mean nothing until the viewport transform is applied. Verified
 * against the installed pdf.js source, where the text layer does exactly
 * `Util.transform(viewport.transform, item.transform)` and then takes the font
 * height as `Math.hypot(tx[2], tx[3])` with the origin at `tx[4], tx[5]`.
 *
 * An item's `width` is the advance of its whole string, so one item becomes one
 * token rather than a guessed word-split. A wrong split is worse than a coarse
 * box here: a box drawn over the wrong span redacts innocent text and still
 * looks like it worked.
 */
function tokensFromTextLayer(
  items: readonly (TextItem | { type?: string })[],
  viewport: { transform: number[]; scale: number }
): OcrToken[] | null {
  const tokens: OcrToken[] = [];
  let lineIndex = 0;
  for (const item of items) {
    if (tokens.length >= MAX_TEXT_TOKENS) break;
    const textItem = item as TextItem;
    // Marked-content entries carry a `type`, not a `str`. They are not glyphs.
    if (typeof textItem.str !== "string") continue;
    const text = textItem.str;
    if (text.trim().length === 0) continue;

    const tx = pdfjsLib.Util.transform(viewport.transform, textItem.transform);
    if (!Array.isArray(tx) || tx.length < 6 || !tx.every((n) => Number.isFinite(n))) continue;

    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (!Number.isFinite(fontHeight) || fontHeight <= 0) continue;

    // `width` is the item advance in text units; scale it into canvas pixels.
    const width = Math.abs(textItem.width) * viewport.scale;
    if (!Number.isFinite(width) || width <= 0) continue;

    const slack = horizontalSlack(fontHeight);
    tokens.push({
      text,
      // The text layer is the document's own characters, so it is exact
      // evidence rather than a recognition estimate. Detection confidence is a
      // separate value (see core.ts); this one only has to be honest about the
      // source, and a text-layer token is not a guess.
      confidence: 100,
      lineIndex,
      bbox: {
        x: tx[4] - slack,
        y: tx[5] - fontHeight,
        width: width + slack * 2,
        height: fontHeight,
      },
    });
    // `hasEOL` marks the end of a line. Starting a new line index here is what
    // makes a value split across two lines produce two rects instead of one
    // box spanning unrelated text.
    if (textItem.hasEOL) lineIndex += 1;
  }
  return tokens.length > 0 ? tokens : null;
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
      let tokens: OcrToken[] | null = null;
      try {
        // Read the text layer against the SAME viewport the page was rendered
        // with. If the pixel cap above rescaled the viewport, using the unscaled
        // one would place every box at the wrong coordinates.
        const textContent = await page.getTextContent();
        tokens = tokensFromTextLayer(textContent.items, viewport);
        hasTextLayer = tokens !== null;
      } catch {
        hasTextLayer = false;
        tokens = null;
      }
      out.push({
        index: i - 1,
        canvas,
        widthPx: canvas.width,
        heightPx: canvas.height,
        widthPt: base.width,
        heightPt: base.height,
        hasTextLayer,
        tokens,
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