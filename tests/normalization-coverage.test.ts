// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  createInitialCoverage,
  updateCoverageWithBoundaries,
  setDynamicContentMonitored,
  setVirtualizedContentStatus,
  formatCoverageSummary,
} from "../src/content/normalization/coverage.js";
import type { CanonicalBoundary } from "../src/content/normalization/types.js";

describe("createInitialCoverage", () => {
  it("returns complete coverage with no boundaries", () => {
    const coverage = createInitialCoverage();
    expect(coverage.dom).toBe("complete");
    expect(coverage.shadowDom).toBe("complete");
    expect(coverage.sameOriginFrames).toBe("complete");
    expect(coverage.crossOriginFrames).toBe("complete");
    expect(coverage.dynamicContent).toBe("unmonitored");
    expect(coverage.virtualizedContent).toBe("unknown");
    expect(coverage.complete).toBe(true);
  });
});

describe("updateCoverageWithBoundaries", () => {
  it("marks complete when all boundaries are accessible", () => {
    const initial = createInitialCoverage();
    const boundaries: CanonicalBoundary[] = [
      { kind: "shadow-root", status: "complete", nodeId: "sr_0" },
      { kind: "iframe", status: "complete", nodeId: "if_0" },
    ];
    const updated = updateCoverageWithBoundaries(initial, boundaries);
    expect(updated.complete).toBe(true);
    expect(updated.inaccessibleBoundaries).toBe(0);
    expect(updated.totalBoundaries).toBe(2);
  });

  it("marks partial when shadow DOM has inaccessible boundaries", () => {
    const initial = createInitialCoverage();
    const boundaries: CanonicalBoundary[] = [
      { kind: "shadow-root", status: "complete", nodeId: "sr_0" },
      { kind: "closed-shadow-root", status: "inaccessible", nodeId: "sr_1" },
    ];
    const updated = updateCoverageWithBoundaries(initial, boundaries);
    expect(updated.complete).toBe(false);
    expect(updated.shadowDom).toBe("partial");
    expect(updated.inaccessibleBoundaries).toBe(1);
  });

  it("marks cross-origin frames as inaccessible", () => {
    const initial = createInitialCoverage();
    const boundaries: CanonicalBoundary[] = [
      { kind: "cross-origin-frame", status: "inaccessible", nodeId: "if_0" },
    ];
    const updated = updateCoverageWithBoundaries(initial, boundaries);
    expect(updated.crossOriginFrames).toBe("inaccessible");
    expect(updated.complete).toBe(false);
  });
});

describe("setDynamicContentMonitored", () => {
  it("sets dynamic content to monitored", () => {
    const initial = createInitialCoverage();
    const updated = setDynamicContentMonitored(initial);
    expect(updated.dynamicContent).toBe("monitored");
  });
});

describe("setVirtualizedContentStatus", () => {
  it("sets virtualized content status", () => {
    const initial = createInitialCoverage();
    const updated = setVirtualizedContentStatus(initial, "dom-visible-only");
    expect(updated.virtualizedContent).toBe("dom-visible-only");
  });
});

describe("formatCoverageSummary", () => {
  it("returns simple summary for complete coverage", () => {
    const coverage = createInitialCoverage();
    const summary = formatCoverageSummary(coverage);
    expect(summary).toContain("DOM: complete");
  });

  it("includes inaccessible boundary count", () => {
    const initial = createInitialCoverage();
    const boundaries: CanonicalBoundary[] = [
      { kind: "cross-origin-frame", status: "inaccessible", nodeId: "if_0" },
    ];
    const updated = updateCoverageWithBoundaries(initial, boundaries);
    const summary = formatCoverageSummary(updated);
    expect(summary).toContain("1 inaccessible boundary");
  });
});
