// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { CoverageInfo, CanonicalBoundary } from "./types.js";

export function createInitialCoverage(): CoverageInfo {
  return {
    dom: "complete",
    shadowDom: "complete",
    sameOriginFrames: "complete",
    crossOriginFrames: "complete",
    dynamicContent: "unmonitored",
    virtualizedContent: "unknown",
    totalBoundaries: 0,
    inaccessibleBoundaries: 0,
    complete: true,
  };
}

export function updateCoverageWithBoundaries(
  coverage: CoverageInfo,
  boundaries: CanonicalBoundary[]
): CoverageInfo {
  let inaccessible = 0;
  let hasShadow = false;
  let hasCrossOrigin = false;

  for (const b of boundaries) {
    if (b.status === "inaccessible") inaccessible++;
    if (b.kind === "shadow-root" || b.kind === "closed-shadow-root") hasShadow = true;
    if (b.kind === "cross-origin-frame") hasCrossOrigin = true;
  }

  return {
    ...coverage,
    shadowDom: !hasShadow ? "complete" : inaccessible > 0 ? "partial" : "complete",
    crossOriginFrames: !hasCrossOrigin ? "complete" : inaccessible > 0 ? "inaccessible" : "complete",
    totalBoundaries: boundaries.length,
    inaccessibleBoundaries: inaccessible,
    complete: inaccessible === 0,
  };
}

export function setDynamicContentMonitored(coverage: CoverageInfo): CoverageInfo {
  return { ...coverage, dynamicContent: "monitored" };
}

export function setVirtualizedContentStatus(
  coverage: CoverageInfo,
  status: "dom-visible-only" | "unknown"
): CoverageInfo {
  return { ...coverage, virtualizedContent: status };
}

export function formatCoverageSummary(coverage: CoverageInfo): string {
  const parts: string[] = [];
  parts.push(`DOM: ${coverage.dom}`);
  if (coverage.shadowDom !== "complete") parts.push(`Shadow DOM: ${coverage.shadowDom}`);
  if (coverage.sameOriginFrames !== "complete") parts.push(`Frames: ${coverage.sameOriginFrames}`);
  if (coverage.crossOriginFrames !== "complete") parts.push(`Cross-origin: ${coverage.crossOriginFrames}`);
  if (coverage.inaccessibleBoundaries > 0) {
    parts.push(`${coverage.inaccessibleBoundaries} inaccessible boundary(ies)`);
  }
  return parts.join(", ");
}
