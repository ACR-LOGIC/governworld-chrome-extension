// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
export type {
  SourceKind,
  BoundaryKind,
  BoundaryStatus,
  BoundaryInfo,
  CoverageInfo,
  CanonicalSegment,
  CanonicalBoundary,
  CanonicalDocument,
  NormalizedFinding,
  NormalizationResult,
} from "./types.js";
export { buildCanonicalDocument } from "./canonical.js";
export {
  createInitialCoverage,
  updateCoverageWithBoundaries,
  setDynamicContentMonitored,
  setVirtualizedContentStatus,
  formatCoverageSummary,
} from "./coverage.js";
export {
  observeMutations,
  shouldInvalidateBatch,
  getAffectedNodeIds,
  type MutationBatch,
  type MutationCallback,
  type MutationObserverHandle,
} from "./mutation.js";
export { traverseIframes, isFrameAccessible, type IframeTraversalResult } from "./iframe.js";
export {
  extractTableStructures,
  annotateSegmentsWithTableStructure,
  formatTableContext,
  type TableStructure,
} from "./table.js";
export {
  normalizeUnicodeWithMapping,
  mapNormalizedToOriginalOffset,
  mapOriginalToNormalizedOffset,
  type UnicodeMapping,
  type UnicodeNormalizationResult,
} from "./unicode.js";
