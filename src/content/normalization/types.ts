// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { FindingCategory } from "../../shared/types.js";
import type { TextSegment } from "../extract.js";

export type SourceKind = "web-dom" | "document-ocr" | "document-pdf" | "document-docx";

export type BoundaryKind = "shadow-root" | "iframe" | "closed-shadow-root" | "cross-origin-frame";

export type BoundaryStatus = "complete" | "partial" | "inaccessible";

export interface BoundaryInfo {
  kind: BoundaryKind;
  status: BoundaryStatus;
  nodeId?: string;
  frameId?: string;
  shadowRootId?: string;
}

export interface CoverageInfo {
  dom: BoundaryStatus;
  shadowDom: BoundaryStatus;
  sameOriginFrames: BoundaryStatus;
  crossOriginFrames: BoundaryStatus;
  dynamicContent: "monitored" | "unmonitored";
  virtualizedContent: "dom-visible-only" | "unknown";
  totalBoundaries: number;
  inaccessibleBoundaries: number;
  complete: boolean;
}

export interface CanonicalSegment extends TextSegment {
  combinedStartOffset: number;
  combinedEndOffset: number;
  tableRole?: "header" | "cell" | "row-header";
  tableRow?: number;
  tableCol?: number;
  frameId?: string;
  shadowRootId?: string;
}

export interface CanonicalBoundary {
  kind: BoundaryKind;
  status: BoundaryStatus;
  nodeId?: string;
  frameId?: string;
  shadowRootId?: string;
}

export interface CanonicalDocument {
  documentId: string;
  sourceKind: SourceKind;
  combined: string;
  segments: CanonicalSegment[];
  segmentStarts: number[];
  truncated: boolean;
  coverage: CoverageInfo;
  boundaries: CanonicalBoundary[];
  metadata: {
    nodeCount: number;
    textNodeCount: number;
    shadowRootCount: number;
    iframeCount: number;
    tableCount: number;
    durationMs: number;
  };
}

export interface NormalizedFinding {
  category: FindingCategory;
  confidence: number;
  value: string;
  combinedStart: number;
  combinedEnd: number;
  segmentIds: string[];
  mapped: boolean;
  mapFailureReason?: string;
  sourceNodeIds: string[];
  tableRole?: "header" | "cell" | "row-header";
  frameId?: string;
  shadowRootId?: string;
}

export interface NormalizationResult {
  document: CanonicalDocument;
  findings: NormalizedFinding[];
  mappingFailures: NormalizedFinding[];
}
