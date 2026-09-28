// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { CanonicalDocument, CanonicalSegment, CanonicalBoundary, CoverageInfo, BoundaryInfo } from "./types.js";
import { extractVisibleText, buildScanText, type TextSegment } from "../extract.js";

let boundaryCounter = 0;

function generateBoundaryId(): string {
  return `boundary_${++boundaryCounter}`;
}

export function buildCanonicalDocument(options: {
  root: Document | Element | ShadowRoot;
  sourceKind?: CanonicalDocument["sourceKind"];
  maxVisibleChars?: number;
  maxNodeChars?: number;
  nodeIds: Map<string, Node>;
}): CanonicalDocument {
  const startTime = performance.now();
  const maxVisibleChars = options.maxVisibleChars ?? 250_000;
  const maxNodeChars = options.maxNodeChars ?? 10_000;
  const sourceKind = options.sourceKind ?? "web-dom";

  const boundaries: CanonicalBoundary[] = [];
  let shadowRootCount = 0;
  let iframeCount = 0;
  let tableCount = 0;
  let inaccessibleBoundaries = 0;

  const { segments: rawSegments, truncated } = extractVisibleText(
    options.root,
    maxVisibleChars,
    maxNodeChars,
    options.nodeIds
  );

  const { combined, segmentStarts } = buildScanText(rawSegments);

  let textNodeCount = 0;
  for (const seg of rawSegments) {
    const node = options.nodeIds.get(seg.nodeId);
    if (node && node.nodeType === Node.TEXT_NODE) {
      textNodeCount++;
    }
  }

  shadowRootCount = countShadowRoots(options.root);
  iframeCount = countIframes(options.root);
  tableCount = countTables(options.root);

  for (const iframe of collectIframes(options.root)) {
    if (iframe.accessible) {
      boundaries.push({
        kind: "iframe",
        status: "complete",
        nodeId: generateBoundaryId(),
        frameId: iframe.id,
      });
    } else {
      boundaries.push({
        kind: "cross-origin-frame",
        status: "inaccessible",
        nodeId: generateBoundaryId(),
        frameId: iframe.id,
      });
      inaccessibleBoundaries++;
    }
  }

  for (const shadow of collectShadowRoots(options.root)) {
    if (shadow.accessible) {
      boundaries.push({
        kind: "shadow-root",
        status: "complete",
        nodeId: generateBoundaryId(),
        shadowRootId: shadow.id,
      });
    } else {
      boundaries.push({
        kind: "closed-shadow-root",
        status: "inaccessible",
        nodeId: generateBoundaryId(),
        shadowRootId: shadow.id,
      });
      inaccessibleBoundaries++;
    }
  }

  const hasInaccessible = inaccessibleBoundaries > 0;

  const coverage: CoverageInfo = {
    dom: "complete",
    shadowDom: shadowRootCount === 0 ? "complete" : hasInaccessible ? "partial" : "complete",
    sameOriginFrames: iframeCount === 0 ? "complete" : "complete",
    crossOriginFrames: hasInaccessible ? "inaccessible" : "complete",
    dynamicContent: "monitored",
    virtualizedContent: "dom-visible-only",
    totalBoundaries: boundaries.length,
    inaccessibleBoundaries,
    complete: !hasInaccessible && !truncated,
  };

  const canonicalSegments: CanonicalSegment[] = rawSegments.map((seg, i) => {
    const segStart = segmentStarts[i] ?? 0;
    const node = options.nodeIds.get(seg.nodeId);
    const isInput = node && (node.nodeName === "INPUT" || node.nodeName === "TEXTAREA");

    return {
      nodeId: seg.nodeId,
      startOffset: seg.startOffset,
      endOffset: seg.endOffset,
      text: seg.text,
      sourceNodeId: seg.nodeId,
      sourceType: isInput ? (node.nodeName === "TEXTAREA" ? "textarea" : "input") : "text",
      sourceStartOffset: seg.startOffset,
      sourceEndOffset: seg.endOffset,
      combinedStartOffset: segStart,
      combinedEndOffset: segStart + seg.text.length,
    };
  });

  const durationMs = performance.now() - startTime;

  return {
    documentId: crypto.randomUUID(),
    sourceKind,
    combined,
    segments: canonicalSegments,
    segmentStarts,
    truncated,
    coverage,
    boundaries,
    metadata: {
      nodeCount: options.nodeIds.size,
      textNodeCount,
      shadowRootCount,
      iframeCount,
      tableCount,
      durationMs: Math.round(durationMs),
    },
  };
}

function countShadowRoots(root: Document | Element | ShadowRoot): number {
  let count = 0;
  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.shadowRoot) {
        count++;
        walk(el.shadowRoot);
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
  };
  walk(doc);
  return count;
}

function countIframes(root: Document | Element | ShadowRoot): number {
  let count = 0;
  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.tagName === "IFRAME") count++;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
  };
  walk(doc);
  return count;
}

function countTables(root: Document | Element | ShadowRoot): number {
  let count = 0;
  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.tagName === "TABLE") count++;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
  };
  walk(doc);
  return count;
}

interface IframeInfo {
  id: string;
  accessible: boolean;
}

function collectIframes(root: Document | Element | ShadowRoot): IframeInfo[] {
  const iframes: IframeInfo[] = [];
  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.tagName === "IFRAME") {
        let accessible = false;
        try {
          accessible = !!(el as HTMLIFrameElement).contentDocument;
        } catch {
          accessible = false;
        }
        iframes.push({ id: `iframe_${iframes.length}`, accessible });
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
  };
  walk(doc);
  return iframes;
}

interface ShadowRootInfo {
  id: string;
  accessible: boolean;
}

function collectShadowRoots(root: Document | Element | ShadowRoot): ShadowRootInfo[] {
  const roots: ShadowRootInfo[] = [];
  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.shadowRoot) {
        roots.push({ id: `shadow_${roots.length}`, accessible: true });
        walk(el.shadowRoot);
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
  };
  walk(doc);
  return roots;
}
