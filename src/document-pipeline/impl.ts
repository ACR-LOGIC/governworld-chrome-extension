// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { DocumentPage, RedactedDocumentResult } from "./adapter.js";
import type { DocKind, FindingCategory, Rect, RedactionOptions } from "../shared/types.js";
import { renderPdfPages, type RenderedPage } from "./pdf.js";
import { ocrCanvas, ocrPages } from "./ocr.js";
import { loadImagePage, type ImagePage } from "./image.js";
import { loadDocxPages } from "./docx.js";
import { findingsFromOcrPages } from "./core.js";
import { applyBoxes, canvasToPngBytes, pagesToPdf } from "./render.js";
import { pagePixelVerification, verifyCanvasRegions, verifyEncodedPng, type RedactionVerification, type RegionCoverage } from "./verify.js";

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
const DEFAULT_PADDING = 4;

async function canvasToThumbnail(canvas: HTMLCanvasElement): Promise<string> {
  const scale = Math.min(1, THUMB_MAX_WIDTH / canvas.width, THUMB_MAX_HEIGHT / canvas.height);
  const thumb = document.createElement("canvas");
  thumb.width = Math.max(1, Math.floor(canvas.width * scale));
  thumb.height = Math.max(1, Math.floor(canvas.height * scale));
  const ctx = thumb.getContext("2d");
  if (!ctx) throw new Error("Canvas rendering is unavailable.");
  ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL("image/png");
}

export interface PreviewInput extends PipelineInput {
  enabledCategories: FindingCategory[];
  maxPages: number;
  ocrLanguage?: string;
}

export interface RedactOutput {
  outputBytes: Uint8Array;
  outputMimeType: string;
  outputName: string;
  redactedCount: number;
  verification: RedactionVerification;
}

async function loadPages(
  input: PipelineInput,
  maxPages: number
): Promise<{ pages: (RenderedPage | ImagePage)[]; flattenToPdf: boolean }> {
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

export async function runDocumentPreview(input: PreviewInput): Promise<DocumentPage[]> {
  const { pages } = await loadPages(input, input.maxPages);
  const ocrResults = await ocrPages(pages.map((p) => p.canvas), input.ocrLanguage ?? "eng");
  const findings = findingsFromOcrPages(ocrResults, input.enabledCategories);
  const grouped = new Map<number, DocumentPage>();
  for (const page of pages) {
    grouped.set(page.index, {
      index: page.index,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      previewDataUrl: await canvasToThumbnail(page.canvas),
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

export async function runDocumentRedact(
  input: PipelineInput,
  boxes: { pageIndex: number; rects: Rect[] }[],
  maxPages: number,
  padding = DEFAULT_PADDING,
  options?: RedactionOptions
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
      verification: pagePixelVerification(totals)
    };
  }

  const outputBytes = await canvasToPngBytes(pages[0].canvas);
  const base = input.name.replace(/\.[a-z0-9]+$/i, "");
  // Image output is single-page, so the finished PNG can be re-decoded and
  // checked directly. That is the strongest claim available: these are the exact
  // bytes the browser will write to disk.
  const verification = await verifyEncodedPng(outputBytes, boxMap.get(pages[0].index) ?? [], padding, options);
  return { outputBytes, outputMimeType: "image/png", outputName: `${base}-redacted.png`, redactedCount, verification };
}