// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { Finding } from "../shared/types.js";

/**
 * Visible-text extraction for the top-level document.
 * Extraction is read-only; page text is never mutated while scanning.
 */

export interface TextSegment {
  /** Stable id assigned during the scan, resolvable to the Text node in-session. */
  nodeId: string;
  /** Offsets into the original text node. */
  startOffset: number;
  endOffset: number;
  /** The extracted slice (may be truncated at the per-node cap). */
  text: string;
}

export interface ScanText {
  /** Segments in document order, joined by "\n". */
  segments: TextSegment[];
  /** combined offset where each segment begins. */
  segmentStarts: number[];
  combined: string;
  truncated: boolean;
}

export const OVERLAY_ATTR = "data-gw-scan-overlay";
export const IGNORE_ATTR = "data-sensitive-scan-ignore";

const EXCLUDED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SVG",
  "CANVAS",
  "METER",
  "PROGRESS",
  "OBJECT",
  "EMBED",
  "IFRAME",
]);

const EXCLUDED_AUTOCOMPLETE = new Set([
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-name",
  "cc-type",
  "one-time-code",
]);

/** True when the element (or an ancestor) should be excluded from scanning. */
export function isExcludedElement(el: Element): boolean {
  if (el.closest?.(`[${OVERLAY_ATTR}]`)) return true;
  if (el.closest?.(`[${IGNORE_ATTR}]`)) return true;

  const blocked = el.closest?.(Array.from(EXCLUDED_TAGS).map((t) => t.toLowerCase()).join(","));
  if (blocked) return true;

  const ariaHidden = el.closest?.("[aria-hidden='true']");
  if (ariaHidden) return true;

  const hidden = el.closest?.("[hidden], [inert]");
  if (hidden) return true;

  const password = el.closest?.("[type='password']");
  if (password) return true;

  const auto = el.closest?.("[autocomplete]");
  if (auto) {
    const ac = (auto.getAttribute("autocomplete") || "").split(/\s+/)[0].toLowerCase();
    if (EXCLUDED_AUTOCOMPLETE.has(ac)) return true;
  }

  try {
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    } else if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return true;
      }
    }
  } catch {
    // Default to including text on detached nodes or non-browser envs
  }
  return false;
}

const TRIM_RE = /^[\s\u00a0\u200b]+|[\s\u00a0\u200b]+$/g;

/**
 * Walk visible text nodes, shadow roots, and inputs in the document and produce segments.
 * Truncates oversized nodes and stops at maxVisibleChars (graceful, reported).
 */
export function extractVisibleText(
  root: Document | Element | ShadowRoot,
  maxVisibleChars: number,
  maxNodeChars: number,
  nodeIds: Map<string, Node>
): { segments: TextSegment[]; truncated: boolean } {
  const segments: TextSegment[] = [];
  let remaining = maxVisibleChars;
  let truncated = false;
  let counter = 0;

  function processTextNode(node: Text) {
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const raw = node.textContent ?? "";
    const trimmed = raw.replace(TRIM_RE, "");
    if (trimmed.length === 0) return;

    if (trimmed.length > maxNodeChars) {
      truncated = true;
    }
    const slice = trimmed.slice(0, maxNodeChars);

    const lead = raw.length - raw.replace(/^[\s\u00a0\u200b]+/, "").length;
    const startOffset = lead;
    const endOffset = Math.min(raw.length, lead + slice.length);

    const nodeId = `seg_${counter++}`;
    nodeIds.set(nodeId, node);

    segments.push({ nodeId, startOffset, endOffset, text: slice });
    remaining -= slice.length;
    if (remaining <= 0) {
      truncated = true;
    }
  }

  function processInputElement(el: HTMLInputElement | HTMLTextAreaElement) {
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const raw = el.value ?? "";
    const trimmed = raw.replace(TRIM_RE, "");
    if (trimmed.length === 0) return;

    if (trimmed.length > maxNodeChars) {
      truncated = true;
    }
    const slice = trimmed.slice(0, maxNodeChars);
    const startOffset = 0;
    const endOffset = slice.length;

    const nodeId = `seg_${counter++}`;
    nodeIds.set(nodeId, el);

    segments.push({ nodeId, startOffset, endOffset, text: slice });
    remaining -= slice.length;
    if (remaining <= 0) {
      truncated = true;
    }
  }

  function traverse(current: Node) {
    if (remaining <= 0) {
      truncated = true;
      return;
    }

    if (current.nodeType === Node.ELEMENT_NODE) {
      const el = current as HTMLElement;
      if (isExcludedElement(el)) {
        return;
      }

      const tag = el.tagName.toLowerCase();
      if (
        tag === "textarea" ||
        (tag === "input" && ["text", "search", "email", "tel", "url"].includes((el as HTMLInputElement).type))
      ) {
        processInputElement(el as HTMLInputElement | HTMLTextAreaElement);
      }

      if (el.shadowRoot) {
        traverse(el.shadowRoot);
      }
    } else if (current.nodeType === Node.TEXT_NODE) {
      const parent = current.parentElement;
      if (!parent || !isExcludedElement(parent)) {
        processTextNode(current as Text);
      }
      return;
    }

    let child = current.firstChild;
    while (child && remaining > 0) {
      traverse(child);
      child = child.nextSibling;
    }
  }

  const startNode = root instanceof Document ? (root.body || root.documentElement) : root;
  if (startNode) {
    traverse(startNode);
  }

  return { segments, truncated };
}

/** Join segments into a combined scan string with offset mapping tables. */
export function buildScanText(segments: TextSegment[]): { combined: string; segmentStarts: number[] } {
  const parts: string[] = [];
  const segmentStarts: number[] = [];
  let cursor = 0;
  for (const seg of segments) {
    segmentStarts.push(cursor);
    parts.push(seg.text);
    cursor += seg.text.length + 1; // +1 for the join separator
  }
  return { combined: parts.join("\n"), segmentStarts };
}

/** Find the segment index containing a combined offset (binary search). */
export function segmentIndexAt(segmentStarts: number[], combinedLength: number, offset: number): number {
  if (offset < 0 || offset >= combinedLength) return -1;
  let lo = 0;
  let hi = segmentStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segmentStarts[mid] <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hi;
}

export interface MappedRange {
  nodeId: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Map a finding's combined-text range back to per-segment node ranges.
 * A finding may span multiple segments (e.g. a wrapped phone number).
 */
export function mapRange(
  segments: TextSegment[],
  segmentStarts: number[],
  combinedLength: number,
  start: number,
  end: number
): MappedRange[] {
  const out: MappedRange[] = [];
  const firstSeg = segmentIndexAt(segmentStarts, combinedLength, start);
  if (firstSeg < 0) return out;

  let segIdx = firstSeg;
  let cursor = start;
  while (segIdx < segments.length && cursor < end) {
    const seg = segments[segIdx];
    const segStart = segmentStarts[segIdx];
    const segEnd = segStart + seg.text.length;
    const localStart = cursor - segStart;
    const localEnd = Math.min(end - segStart, seg.text.length);
    if (localStart < seg.text.length && localEnd > 0) {
      out.push({
        nodeId: seg.nodeId,
        startOffset: seg.startOffset + Math.max(0, localStart),
        endOffset: seg.startOffset + Math.min(seg.text.length, localEnd),
      });
    }
    cursor = segEnd + 1; // jump past the join separator
    segIdx += 1;
  }
  return out;
}

const MASK_CHAR = "\u2588"; // full block

/**
 * Build a redacted representation of the scan text: selected finding spans are
 * replaced with solid blocks. This is a separate derived string, never a DOM
 * mutation. Returns redacted text (unselected content preserved).
 */
export function buildRedactedText(
  segments: TextSegment[],
  segmentStarts: number[],
  combinedLength: number,
  findings: Finding[]
): string {
  const spans = findings
    .filter((f) => f.selected)
    .map((f) => ({ start: f.startOffset, end: f.endOffset }))
    .sort((a, b) => a.start - b.start);

  const spansBySegment = new Map<string, MappedRange[]>();
  for (const span of spans) {
    for (const range of mapRange(segments, segmentStarts, combinedLength, span.start, span.end)) {
      const list = spansBySegment.get(range.nodeId) ?? [];
      list.push(range);
      spansBySegment.set(range.nodeId, list);
    }
  }

  return segments
    .map((seg) => {
      const ranges = (spansBySegment.get(seg.nodeId) ?? [])
        .filter((r) => r.startOffset < seg.endOffset && r.endOffset > seg.startOffset)
        .map((r) => ({
          start: Math.max(seg.startOffset, r.startOffset) - seg.startOffset,
          end: Math.min(seg.endOffset, r.endOffset) - seg.startOffset,
        }))
        .sort((a, b) => a.start - b.start);

      const chars = Array.from(seg.text);
      for (const range of ranges) {
        for (let i = range.start; i < range.end; i++) {
          chars[i] = MASK_CHAR;
        }
      }
      return chars.join("");
    })
    .join("\n");
}

/**
 * Redact a slice of the combined scan text. Pure helper used by the copy
 * interceptor: given the combined text and the selection span, replace any
 * selected-finding overlap with solid blocks. Never touches the DOM.
 */
export function maskCombinedRange(
  combined: string,
  start: number,
  end: number,
  findings: Finding[]
): string {
  const lo = Math.max(0, Math.min(start, combined.length));
  const hi = Math.max(lo, Math.min(end, combined.length));
  const chars = Array.from(combined.slice(lo, hi));
  for (const f of findings) {
    if (!f.selected) continue;
    const fs = Math.max(lo, f.startOffset);
    const fe = Math.min(hi, f.endOffset);
    if (fe <= fs) continue;
    for (let i = fs - lo; i < fe - lo; i++) chars[i] = MASK_CHAR;
  }
  return chars.join("");
}

/** Structural subset of DOM Range used by selection mapping. DOM-independent for testability. */
export interface RangeLike<TNode> {
  comparePoint(node: TNode, offset: number): number;
  startContainer: TNode;
  startOffset: number;
  endContainer: TNode;
  endOffset: number;
}

/**
 * Map a user selection (Range-like) to combined-scan offsets. Pure and
 * DOM-independent: the caller supplies node handles, the per-segment mapping,
 * and an optional liveness check. Returns null when the selection overlaps no
 * live scanned text.
 */
export function selectionCombinedSpan<TNode>(
  range: RangeLike<TNode>,
  segments: TextSegment[],
  segmentStarts: number[],
  segmentIndexById: Map<string, number>,
  nodeById: Map<string, TNode>,
  combinedLength: number,
  isLive?: (node: TNode) => boolean
): { start: number; end: number } | null {
  let start = combinedLength;
  let end = 0;
  let found = false;
  for (const [nodeId, node] of nodeById) {
    if (isLive && !isLive(node)) continue;
    const segIdx = segmentIndexById.get(nodeId);
    if (segIdx === undefined) continue;
    const seg = segments[segIdx];
    const segStart = segmentStarts[segIdx];
    const a = range.comparePoint(node, seg.startOffset);
    const b = range.comparePoint(node, seg.endOffset);
    if (a === 1 || b === -1) continue; // fully before or after the selection
    let ls = seg.startOffset;
    let le = seg.endOffset;
    if (a === -1) ls = range.startContainer === node ? range.startOffset : seg.startOffset;
    if (b === 1) le = range.endContainer === node ? range.endOffset : seg.endOffset;
    ls = Math.max(seg.startOffset, Math.min(ls, seg.endOffset));
    le = Math.max(seg.startOffset, Math.min(le, seg.endOffset));
    if (le <= ls) continue;
    const cs = segStart + (ls - seg.startOffset);
    const ce = segStart + (le - seg.startOffset);
    start = Math.min(start, cs);
    end = Math.max(end, ce);
    found = true;
  }
  return found ? { start, end } : null;
}