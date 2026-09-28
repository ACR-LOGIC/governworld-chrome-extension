// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { Finding, FindingCategory, Rect } from "../shared/types.js";
import type { CustomPattern } from "../shared/customPatterns.js";
import { maskContext, maskValue } from "../content/detect.js";
import { detect } from "../content/detect.js";
import type { OcrPageResult, OcrToken } from "./ocr.js";

/**
 * Pure document-analysis logic shared by preview and redact paths. Runs inside
 * the offscreen document where DOM canvas + worker APIs exist. Everything here
 * is metadata/rect-based: raw recognized text never leaves the pipeline as a
 * value, only masked previews and rectangles are surfaced.
 */

const TOKEN_GAP_PX = 10;
const CONTEXT_WINDOW = 40;

export interface TokenSpan {
  start: number;
  end: number;
  token: OcrToken;
}

/** Reconstruct char offsets exactly as ocr.ts joins tokens into fullText. */
export function tokenSpans(tokens: OcrToken[]): TokenSpan[] {
  let pos = 0;
  const spans: TokenSpan[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const sep = i > 0 ? (tokens[i].lineIndex !== tokens[i - 1].lineIndex ? "\n" : " ") : "";
    const start = pos + sep.length;
    const end = start + tokens[i].text.length;
    pos = end;
    spans.push({ start, end, token: tokens[i] });
  }
  return spans;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  const pad = TOKEN_GAP_PX;
  return a.x < b.x + b.width + pad && b.x < a.x + a.width + pad;
}

function bboxToRect(b: OcrToken["bbox"]): Rect {
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function unionRect(rects: Rect[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Merge matched token boxes into one or more rects, splitting on line changes
 * so a multi-line match yields separate redaction boxes.
 */
function rectsForSpans(spans: TokenSpan[]): Rect[] {
  const groups: TokenSpan[][] = [];
  for (const span of spans) {
    const last = groups[groups.length - 1];
    if (last && span.token.lineIndex === last[0].token.lineIndex) {
      last.push(span);
    } else {
      groups.push([span]);
    }
  }
  const out: Rect[] = [];
  for (const group of groups) {
    const boxes = group.map((s) => bboxToRect(s.token.bbox));
    const merged: Rect[] = [];
    for (const box of boxes) {
      const idx = merged.findIndex((m) => rectsIntersect(m, box));
      if (idx >= 0) {
        const target = merged[idx];
        const combined = unionRect([target, box]);
        merged[idx] = combined;
      } else {
        merged.push(box);
      }
    }
    out.push(...merged);
  }
  // Prune pathological rects (e.g. zero-area) and merge anything that still overlaps.
  return out.filter((r) => r.width > 0 && r.height > 0);
}

function maskedContext(fullText: string, start: number, end: number): string {
  const before = fullText.slice(Math.max(0, start - CONTEXT_WINDOW), start);
  const after = fullText.slice(end, Math.min(fullText.length, end + CONTEXT_WINDOW));
  return maskContext(`${before} ${after}`.trim());
}

/**
 * Run local detectors over OCR text and produce reviewable findings whose rects
 * are expressed in full-resolution page pixels (OCR coordinates == canvas px).
 */
export function findingsFromOcrPages(
  pages: OcrPageResult[],
  enabledCategories: FindingCategory[],
  customPatterns?: CustomPattern[]
): Finding[] {
  const findings: Finding[] = [];
  for (const page of pages) {
    const spans = tokenSpans(page.tokens);
    const matches = detect(page.fullText, enabledCategories, customPatterns);
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const covered = spans.filter((s) => s.start < match.end && s.end > match.start);
      if (covered.length === 0) continue;
      const rects = rectsForSpans(covered);
      if (rects.length === 0) continue;
      const value = page.fullText.slice(match.start, match.end);
      findings.push({
        id: `doc:${page.pageIndex}:${i}`,
        category: match.category,
        confidence: match.confidence,
        source: "local-rules",
        preview: maskValue(match.category, value),
        nodeId: `doc:${page.pageIndex}`,
        startOffset: match.start,
        endOffset: match.end,
        rects,
        contextPreview: maskedContext(page.fullText, match.start, match.end),
        // Detected document values are selected by default so the studio opens
        // with its redaction boxes already drawn and "Redact selected" enabled,
        // matching the page-scan path. Attribute findings are the opposite case
        // and stay unselected, since they are never maskable.
        selected: true,
      });
    }
  }
  return findings;
}