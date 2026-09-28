// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { CanonicalDocument, CanonicalSegment, BoundaryInfo } from "./types.js";
import { buildCanonicalDocument } from "./canonical.js";

export interface IframeTraversalResult {
  frameDocuments: CanonicalDocument[];
  boundaries: BoundaryInfo[];
}

export function traverseIframes(
  root: Document | Element | ShadowRoot,
  options: {
    maxVisibleChars?: number;
    maxNodeChars?: number;
    nodeIds: Map<string, Node>;
  }
): IframeTraversalResult {
  const frameDocuments: CanonicalDocument[] = [];
  const boundaries: BoundaryInfo[] = [];

  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const iframes = doc.querySelectorAll("iframe");

  for (const iframe of iframes) {
    const el = iframe as HTMLIFrameElement;
    let accessible = false;
    let frameDoc: Document | null = null;

    try {
      frameDoc = el.contentDocument;
      accessible = frameDoc !== null;
    } catch {
      accessible = false;
    }

    if (!accessible || !frameDoc) {
      boundaries.push({
        kind: "cross-origin-frame",
        status: "inaccessible",
        nodeId: `iframe_boundary_${boundaries.length}`,
        frameId: `frame_${frameDocuments.length}`,
      });
      continue;
    }

    const frameNodeIds = new Map<string, Node>();
    const frameDocCanonical = buildCanonicalDocument({
      root: frameDoc,
      sourceKind: "web-dom",
      maxVisibleChars: options.maxVisibleChars,
      maxNodeChars: options.maxNodeChars,
      nodeIds: frameNodeIds,
    });

    frameNodeIds.forEach((node, id) => {
      options.nodeIds.set(`frame_${frameDocuments.length}_${id}`, node);
    });

    const remappedSegments: CanonicalSegment[] = frameDocCanonical.segments.map((seg) => ({
      ...seg,
      frameId: `frame_${frameDocuments.length}`,
      nodeId: `frame_${frameDocuments.length}_${seg.nodeId}`,
    }));

    frameDocuments.push({
      ...frameDocCanonical,
      segments: remappedSegments,
      boundaries: [],
    });

    boundaries.push({
      kind: "iframe",
      status: "complete",
      nodeId: `iframe_boundary_${boundaries.length}`,
      frameId: `frame_${frameDocuments.length - 1}`,
    });
  }

  return { frameDocuments, boundaries };
}

export function isFrameAccessible(iframe: HTMLIFrameElement): boolean {
  try {
    return iframe.contentDocument !== null;
  } catch {
    return false;
  }
}
