// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { DocumentPage, RedactedDocumentResult } from "./adapter.js";
import type { DocKind, FindingCategory, Rect, RedactionOptions } from "../shared/types.js";
import type { CustomPattern } from "../shared/customPatterns.js";
import { renderPdfPages, type RenderedPage } from "./pdf.js";
import { ocrCanvas, type OcrPageResult, type OcrToken } from "./ocr.js";
import { assembleOcrText } from "./offsets.js";
import { loadImagePage, type ImagePage } from "./image.js";
import { loadDocxPages } from "./docx.js";
import { findingsFromOcrPages } from "./core.js";
import { applyBoxes, canvasToPngBytes, pagesToPdf } from "./render.js";
import { pagePixelVerification, verifyCanvasRegions, verifyEncodedPng, type RedactionVerification, type RegionCoverage } from "./verify.js";
import {
  previewKey as previewStoreKey,
  pageImageKey as pageImageStoreKey,
  putDocBytes,
  redactedKey,
  redactedManifestKey,
  type RedactedDocRef,
  type RedactedPageRef,
} from "../shared/docStore.js";

/**
 * Document pipeline implementation. Runs inside the offscreen document where
 * DOM canvas + Worker APIs exist. The service worker never touches these — it
 * talks to this via the offscreen contract.
 */

export interface PipelineInput {
  kind: DocKind | "docx";
  bytes: ArrayBuffer;
  name: string;
  mimeType: string;
}

const THUMB_MAX_WIDTH = 320;
const THUMB_MAX_HEIGHT = 480;
/**
 * Longest edge of the review page image, in pixels.
 *
 * This is a real-resolution copy of the rendered page, so it is the expensive
 * one: IndexedDB has to hold it for the life of the session. A 1240x1754 letter
 * page at 150 DPI is 1275x1650, which is what the review surface actually shows,
 * so this bound passes a normal page through untouched and only trims a very
 * large scan. Anything above it would cost storage without making the page
 * more readable, because the review page scales to the window.
 */
const PAGE_IMAGE_MAX_EDGE = 2000;
const DEFAULT_PADDING = 4;

async function canvasToThumbnailBytes(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  const scale = Math.min(1, THUMB_MAX_WIDTH / canvas.width, THUMB_MAX_HEIGHT / canvas.height);
  const thumb = document.createElement("canvas");
  thumb.width = Math.max(1, Math.floor(canvas.width * scale));
  thumb.height = Math.max(1, Math.floor(canvas.height * scale));
  const ctx = thumb.getContext("2d");
  if (!ctx) throw new Error("Canvas rendering is unavailable.");
  ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  const blob = await new Promise<Blob | null>((resolve) => thumb.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not encode the page preview.");
  return blob.arrayBuffer();
}

/**
 * Encode the page at (bounded) native resolution for the review surface.
 *
 * The thumbnail is 320px wide because the popup is a narrow column; the review
 * page shows the document large enough to read, and upscaling a 320px bitmap to
 * that size is a blurry guess at the words the user is about to decide whether
 * to redact. This is the real render.
 *
 * Returns null instead of throwing when the copy cannot be made. A missing
 * review image degrades that page to the thumbnail; it must never fail a
 * preview whose findings are already computed.
 */
async function canvasToPageImageBytes(canvas: HTMLCanvasElement): Promise<ArrayBuffer | null> {
  try {
    const scale = Math.min(1, PAGE_IMAGE_MAX_EDGE / Math.max(canvas.width, canvas.height));
    let source = canvas;
    if (scale < 1) {
      const scaled = document.createElement("canvas");
      scaled.width = Math.max(1, Math.floor(canvas.width * scale));
      scaled.height = Math.max(1, Math.floor(canvas.height * scale));
      const ctx = scaled.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
      source = scaled;
    }
    const blob = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, "image/png"));
    if (!blob) return null;
    return await blob.arrayBuffer();
  } catch {
    return null;
  }
}

export interface PreviewInput extends PipelineInput {
  enabledCategories: FindingCategory[];
  maxPages: number;
  ocrLanguage?: string;
  customPatterns?: CustomPattern[];
  /**
   * Identifier the caller uses to derive preview store keys. The preview bitmap
   * is written to the shared document store rather than returned inline, because
   * a base64 page image is far larger than a runtime message may be.
   */
  previewKeyPrefix: string;
}

/**
 * Every page source, unified on the fields the preview path needs.
 *
 * The three loaders now all report the text they can read themselves, so the
 * OCR decision is made once, here, instead of inside each loader.
 */
type LoadedPage = (RenderedPage | ImagePage) & { tokens: OcrToken[] | null };

export interface RedactOutput {
  outputBytes: Uint8Array;
  outputMimeType: string;
  outputName: string;
  redactedCount: number;
  verification: RedactionVerification;
  /** Store-backed handle for the print/PDF view, or null if staging failed. */
  printRef?: RedactedDocRef | null;
}

async function loadPages(
  input: PipelineInput,
  maxPages: number
): Promise<{ pages: LoadedPage[]; flattenToPdf: boolean }> {
  if (input.kind === "pdf") {
    const rendered = await renderPdfPages(input.bytes, maxPages);
    return { pages: rendered, flattenToPdf: true };
  }
  if (input.kind === "docx") {
    const rendered = await loadDocxPages(input.bytes);
    return { pages: rendered.slice(0, maxPages), flattenToPdf: true };
  }
  const page = await loadImagePage(input.bytes);
  return { pages: [page], flattenToPdf: false };
}

/**
 * Read every page, using the page's own text where it exists.
 *
 * A PDF page born digital carries its exact text, and a DOCX page is drawn from
 * known text at known coordinates, so both hand back tokens directly. Only a
 * page with no readable text of its own — a scan, a screenshot, a photo — is
 * sent to OCR, which is the slow path and the one that guesses characters.
 */
async function readPages(pages: LoadedPage[], ocrLanguage: string): Promise<OcrPageResult[]> {
  const out: OcrPageResult[] = [];
  for (const page of pages) {
    if (page.tokens && page.tokens.length > 0) {
      // Same assembler OCR uses, so text and offsets cannot disagree.
      out.push({
        pageIndex: page.index,
        widthPx: page.widthPx,
        heightPx: page.heightPx,
        tokens: page.tokens,
        fullText: assembleOcrText(page.tokens),
      });
      continue;
    }
    out.push(await ocrCanvas(page.canvas, page.index, ocrLanguage));
  }
  return out;
}

export async function runDocumentPreview(input: PreviewInput): Promise<DocumentPage[]> {
  const { pages } = await loadPages(input, input.maxPages);
  const ocrResults = await readPages(pages, input.ocrLanguage ?? "eng");
  const findings = findingsFromOcrPages(ocrResults, input.enabledCategories, input.customPatterns);
  const grouped = new Map<number, DocumentPage>();
  for (const page of pages) {
    // Persist the rendered bitmap and hand back only its key. The image cannot
    // ride along in the reply, which crosses a runtime-message boundary.
    const previewKey = previewStoreKey(input.previewKeyPrefix, page.index);
    await putDocBytes(previewKey, await canvasToThumbnailBytes(page.canvas));
    // The real-resolution copy for the review page. Best-effort by design: the
    // review surface falls back to the thumbnail if this is absent.
    const pageImageKey = pageImageStoreKey(input.previewKeyPrefix, page.index);
    const pageBytes = await canvasToPageImageBytes(page.canvas);
    if (pageBytes) await putDocBytes(pageImageKey, pageBytes);
    grouped.set(page.index, {
      index: page.index,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      previewKey,
      ...(pageBytes ? { pageImageKey } : {}),
      findings: [],
    });
  }
  for (const f of findings) {
    const pageIndex = Number(f.nodeId.split(":").pop());
    const page = grouped.get(pageIndex);
    if (page) page.findings.push(f);
  }
  return [...grouped.values()];
}

/**
 * Write the redacted page bitmaps and a manifest into the shared document store,
 * keyed by fileKey, so redact.html can render and print them later.
 *
 * Runs after applyBoxes + verifyCanvasRegions, so what is staged is exactly what
 * was verified. A failure here is non-fatal: the flattened output is already
 * produced, and a print view is an extra affordance, not part of the redaction
 * guarantee.
 */
async function stageRedactedPages(
  pages: LoadedPage[],
  name: string,
  redactedCount: number,
  fileKey: string
): Promise<RedactedDocRef | null> {
  try {
    const refs: RedactedPageRef[] = [];
    for (const page of pages) {
      const png = await canvasToPngBytes(page.canvas);
      const key = redactedKey(fileKey, page.index);
      await putDocBytes(key, png.buffer as ArrayBuffer);
      refs.push({
        pageIndex: page.index,
        key,
        widthPx: page.canvas.width,
        heightPx: page.canvas.height,
        widthPt: page.widthPt,
        heightPt: page.heightPt,
      });
    }
    if (refs.length === 0) return null;
    const manifest: RedactedDocRef = {
      fileKey,
      key: redactedManifestKey(fileKey),
      name,
      pages: refs,
      redactedCount,
      createdAt: Date.now(),
    };
    await putDocBytes(manifest.key, new TextEncoder().encode(JSON.stringify(manifest)).buffer as ArrayBuffer);
    return manifest;
  } catch {
    // Never let the print path turn a completed redaction into a failure.
    return null;
  }
}

export async function runDocumentRedact(
  input: PipelineInput,
  boxes: { pageIndex: number; rects: Rect[] }[],
  maxPages: number,
  padding = DEFAULT_PADDING,
  options?: RedactionOptions,
  fileKey = "print"
): Promise<RedactOutput> {
  const { pages, flattenToPdf } = await loadPages(input, maxPages);
  const boxMap = new Map<number, Rect[]>();
  for (const b of boxes) boxMap.set(b.pageIndex, b.rects);

  // Verify the page bitmaps as they are painted. For flattened output these are
  // the exact pixels that end up on each output page, so a painter that silently
  // no-ops is caught here rather than being reported to the user as a success.
  const totals: RegionCoverage = { checked: 0, dark: 0, failures: [] };
  for (const page of pages) {
    const rects = boxMap.get(page.index);
    if (!rects || rects.length === 0) continue;
    applyBoxes(page.canvas, rects, padding, options);
    const coverage = verifyCanvasRegions(page.canvas, rects, padding, `page ${page.index + 1}`, options);
    totals.checked += coverage.checked;
    totals.dark += coverage.dark;
    totals.failures.push(...coverage.failures);
  }
  const redactedCount = boxes.reduce((n, b) => n + b.rects.length, 0);

  // Stage the redacted pages for the print view. These are the verified pixels,
  // not the source document, so the print view is a pure renderer and cannot
  // itself fail to redact. Written by key rather than inlined: a base64 page
  // image would exceed the runtime message limit.
  const printRef = await stageRedactedPages(pages, input.name, redactedCount, fileKey);

  if (flattenToPdf) {
    const pngs = await Promise.all(
      pages.map(async (p) => ({ pngBytes: await canvasToPngBytes(p.canvas), widthPt: p.widthPt, heightPt: p.heightPt }))
    );
    const outputBytes = await pagesToPdf(pngs);
    const base = input.name.replace(/\.(pdf|docx)$/i, "");
    return {
      outputBytes,
      outputMimeType: "application/pdf",
      outputName: `${base}-redacted.pdf`,
      redactedCount,
      verification: pagePixelVerification(totals),
      printRef,
    };
  }

  const outputBytes = await canvasToPngBytes(pages[0].canvas);
  const base = input.name.replace(/\.[a-z0-9]+$/i, "");
  // Image output is single-page, so the finished PNG can be re-decoded and
  // checked directly. That is the strongest claim available: these are the exact
  // bytes the browser will write to disk.
  const verification = await verifyEncodedPng(outputBytes, boxMap.get(pages[0].index) ?? [], padding, options);
  return {
    outputBytes,
    outputMimeType: "image/png",
    outputName: `${base}-redacted.png`,
    redactedCount,
    verification,
    printRef,
  };
}