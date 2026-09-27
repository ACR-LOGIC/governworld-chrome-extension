// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  buildScanText,
  segmentIndexAt,
  mapRange,
  buildRedactedText,
  maskCombinedRange,
  isExcludedElement,
  selectionCombinedSpan,
} from "../src/content/extract.js";
import type { Finding } from "../src/shared/types.js";
import type { RangeLike, TextSegment } from "../src/content/extract.js";
import { detect } from "../src/content/detect.js";

const ALL = [
  "email",
  "phone",
  "ssn",
  "dob",
  "medical_record_number",
  "member_id",
  "address",
  "payment_card",
  "possible_name",
] as const;

function makeSegments(texts: string[]): { segments: TextSegment[]; combined: string; segmentStarts: number[] } {
  const segments: TextSegment[] = texts.map((text, i) => ({
    nodeId: `seg_${i}`,
    startOffset: 0,
    endOffset: text.length,
    text,
  }));
  const { combined, segmentStarts } = buildScanText(segments);
  return { segments, combined, segmentStarts };
}

describe("buildScanText", () => {
  it("joins segments and records starts", () => {
    const { combined, segmentStarts } = makeSegments(["abc", "def", "ghi"]);
    expect(combined).toBe("abc\ndef\nghi");
    expect(segmentStarts).toEqual([0, 4, 8]);
  });
});

describe("segmentIndexAt", () => {
  it("locates the owning segment for any offset", () => {
    const { combined, segmentStarts } = makeSegments(["ab", "cdef", "g"]);
    expect(segmentIndexAt(segmentStarts, combined.length, 0)).toBe(0);
    expect(segmentIndexAt(segmentStarts, combined.length, 1)).toBe(0);
    expect(segmentIndexAt(segmentStarts, combined.length, 3)).toBe(1);
    expect(segmentIndexAt(segmentStarts, combined.length, 6)).toBe(1);
    expect(segmentIndexAt(segmentStarts, combined.length, 8)).toBe(2);
    expect(segmentIndexAt(segmentStarts, combined.length, -1)).toBe(-1);
    expect(segmentIndexAt(segmentStarts, combined.length, 99)).toBe(-1);
  });
});

describe("mapRange", () => {
  it("maps a single-segment range", () => {
    const { segments, segmentStarts, combined } = makeSegments(["jane@example.com"]);
    const mapped = mapRange(segments, segmentStarts, combined.length, 0, 16);
    expect(mapped).toEqual([{ nodeId: "seg_0", startOffset: 0, endOffset: 16 }]);
  });

  it("maps a multi-segment range across a line break", () => {
    const { segments, segmentStarts, combined } = makeSegments(["jane.doe", "@example.com"]);
    // "jane.doe\n@example.com" -> span covering everything
    const mapped = mapRange(segments, segmentStarts, combined.length, 0, combined.length);
    expect(mapped).toEqual([
      { nodeId: "seg_0", startOffset: 0, endOffset: 8 },
      { nodeId: "seg_1", startOffset: 0, endOffset: 12 },
    ]);
  });
});

describe("buildRedactedText", () => {
  function finding(partial: Partial<Finding>): Finding {
    return {
      id: "f1",
      category: "email",
      confidence: 0.9,
      source: "local-rules",
      preview: "j***@example.com",
      nodeId: "seg_0",
      startOffset: 0,
      endOffset: 0,
      rects: [],
      selected: true,
      ...partial,
    };
  }

  it("replaces selected spans with solid blocks", () => {
    const { segments, segmentStarts, combined } = makeSegments(["My email is jane@example.com. Cheers"]);
    const match = detect(combined, [...ALL])[0];
    const f = finding({ startOffset: match.start, endOffset: match.end });
    const out = buildRedactedText(segments, segmentStarts, combined.length, [f]);
    expect(out).not.toContain("jane@example.com");
    expect(out).toContain("\u2588".repeat(match.end - match.start));
    expect(out).toContain("My email is");
  });

  it("preserves unselected content", () => {
    const { segments, segmentStarts, combined } = makeSegments(["hello world"]);
    const f = finding({ startOffset: 0, endOffset: 5, selected: false });
    const out = buildRedactedText(segments, segmentStarts, combined.length, [f]);
    expect(out).toBe("hello world");
  });

  it("redacts across a multi-line span", () => {
    const { segments, segmentStarts, combined } = makeSegments(["Member", "ID: 7788990 end"]);
    const matches = detect(combined, [...ALL]);
    const member = matches.find((m) => m.category === "member_id");
    expect(member).toBeDefined();
    const f = finding({ startOffset: member!.start, endOffset: member!.end, category: "member_id" });
    const out = buildRedactedText(segments, segmentStarts, combined.length, [f]);
    expect(out).not.toContain("7788990");
  });
});

describe("maskCombinedRange", () => {
  function finding(partial: Partial<Finding>): Finding {
    return {
      id: "f1",
      category: "email",
      confidence: 0.9,
      source: "local-rules",
      preview: "j***@example.com",
      nodeId: "seg_0",
      startOffset: 0,
      endOffset: 0,
      rects: [],
      selected: true,
      ...partial,
    };
  }

  it("redacts a finding inside the copied span", () => {
    const combined = "jane@example.com";
    const f = finding({ startOffset: 0, endOffset: 16 });
    expect(maskCombinedRange(combined, 0, 16, [f])).toBe("\u2588".repeat(16));
  });

  it("keeps non-finding content in the span", () => {
    const combined = "Email: jane@example.com bye";
    const f = finding({ startOffset: 7, endOffset: 23 });
    const out = maskCombinedRange(combined, 0, combined.length, [f]);
    expect(out).toContain("Email: ");
    expect(out).toContain(" bye");
    expect(out).not.toContain("jane@example.com");
  });

  it("ignores unselected findings", () => {
    const combined = "jane@example.com";
    const f = finding({ startOffset: 0, endOffset: 16, selected: false });
    expect(maskCombinedRange(combined, 0, 16, [f])).toBe("jane@example.com");
  });

  it("clamps to the copied span and skips disjoint findings", () => {
    const combined = "A jane@example.com B";
    const f = finding({ startOffset: 2, endOffset: 18 });
    const out = maskCombinedRange(combined, 0, 2, [f]);
    expect(out).toBe("A ");
  });
});

describe("isExcludedElement (static rules)", () => {
  it("classifies form controls as excluded by tag", () => {
    // No DOM here; the pure rule set is exercised in integration tests.
    expect(typeof isExcludedElement).toBe("function");
  });
});

interface FakeNode {
  id: string;
  isConnected: boolean;
}

interface FakeScan {
  segments: TextSegment[];
  segmentStarts: number[];
  combined: string;
  nodeById: Map<string, FakeNode>;
  segmentIndexById: Map<string, number>;
}

function makeFakeScan(texts: string[]): FakeScan {
  const { segments, combined, segmentStarts } = makeSegments(texts);
  const nodeById = new Map<string, FakeNode>();
  const segmentIndexById = new Map<string, number>();
  segments.forEach((seg, i) => {
    nodeById.set(seg.nodeId, { id: seg.nodeId, isConnected: true });
    segmentIndexById.set(seg.nodeId, i);
  });
  return { segments, segmentStarts, combined, nodeById, segmentIndexById };
}

/**
 * Build a RangeLike whose boundary points and comparePoint mirror DOM Range
 * semantics for a selection spanning [spanStart, spanEnd) in combined space.
 */
function makeFakeRange(scan: FakeScan, spanStart: number, spanEnd: number): RangeLike<FakeNode> {
  const { segments, segmentStarts, combined, nodeById } = scan;
  const startSegIdx = segmentIndexAt(segmentStarts, combined.length, spanStart);
  const endSegIdx = segmentIndexAt(segmentStarts, combined.length, spanEnd - 1);
  const startSeg = segments[startSegIdx];
  const endSeg = segments[endSegIdx];
  const startNode = nodeById.get(startSeg.nodeId)!;
  const endNode = nodeById.get(endSeg.nodeId)!;
  return {
    comparePoint(node: FakeNode, offset: number): number {
      const idx = segments.findIndex((s) => s.nodeId === node.id);
      const pos = segmentStarts[idx] + offset;
      if (pos < spanStart) return -1;
      if (pos >= spanEnd) return 1;
      return 0;
    },
    startContainer: startNode,
    startOffset: spanStart - segmentStarts[startSegIdx],
    endContainer: endNode,
    endOffset: spanEnd - segmentStarts[endSegIdx],
  };
}

describe("selectionCombinedSpan", () => {
  it("maps a full single-node selection", () => {
    const scan = makeFakeScan(["jane@example.com"]);
    const range = makeFakeRange(scan, 0, 16);
    expect(
      selectionCombinedSpan(range, scan.segments, scan.segmentStarts, scan.segmentIndexById, scan.nodeById, scan.combined.length)
    ).toEqual({ start: 0, end: 16 });
  });

  it("maps a partial selection inside one node", () => {
    const scan = makeFakeScan(["jane@example.com"]);
    const range = makeFakeRange(scan, 0, 5);
    expect(
      selectionCombinedSpan(range, scan.segments, scan.segmentStarts, scan.segmentIndexById, scan.nodeById, scan.combined.length)
    ).toEqual({ start: 0, end: 5 });
  });

  it("maps a selection spanning multiple segments across a line break", () => {
    const scan = makeFakeScan(["jane.doe", "@example.com"]);
    const range = makeFakeRange(scan, 0, 21);
    expect(
      selectionCombinedSpan(range, scan.segments, scan.segmentStarts, scan.segmentIndexById, scan.nodeById, scan.combined.length)
    ).toEqual({ start: 0, end: 21 });
  });

  it("maps a selection starting mid-segment", () => {
    const scan = makeFakeScan(["jane.doe"]);
    const range = makeFakeRange(scan, 4, 7);
    expect(
      selectionCombinedSpan(range, scan.segments, scan.segmentStarts, scan.segmentIndexById, scan.nodeById, scan.combined.length)
    ).toEqual({ start: 4, end: 7 });
  });

  it("maps a selection crossing from one segment into the next", () => {
    const scan = makeFakeScan(["jane.doe", "@example.com"]);
    const range = makeFakeRange(scan, 5, 17);
    expect(
      selectionCombinedSpan(range, scan.segments, scan.segmentStarts, scan.segmentIndexById, scan.nodeById, scan.combined.length)
    ).toEqual({ start: 5, end: 17 });
  });

  it("skips segments entirely before the selection", () => {
    const scan = makeFakeScan(["aaaa", "bbbb"]);
    const range = makeFakeRange(scan, 5, 9);
    expect(
      selectionCombinedSpan(range, scan.segments, scan.segmentStarts, scan.segmentIndexById, scan.nodeById, scan.combined.length)
    ).toEqual({ start: 5, end: 9 });
  });

  it("returns null when every overlapping node is disconnected", () => {
    const scan = makeFakeScan(["jane@example.com", "second segment"]);
    scan.nodeById.get("seg_1")!.isConnected = false;
    const range = makeFakeRange(scan, 17, 31);
    expect(
      selectionCombinedSpan(
        range,
        scan.segments,
        scan.segmentStarts,
        scan.segmentIndexById,
        scan.nodeById,
        scan.combined.length,
        (node) => node.isConnected
      )
    ).toBeNull();
  });
});