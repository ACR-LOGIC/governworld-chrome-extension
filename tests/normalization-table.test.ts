// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  annotateSegmentsWithTableStructure,
  formatTableContext,
  type TableStructure,
} from "../src/content/normalization/table.js";
import type { CanonicalSegment } from "../src/content/normalization/types.js";

function makeSegment(nodeId: string, text: string): CanonicalSegment {
  return {
    nodeId,
    startOffset: 0,
    endOffset: text.length,
    text,
    combinedStartOffset: 0,
    combinedEndOffset: text.length,
  };
}

function makeTableStructure(): TableStructure {
  return {
    tableId: "table_0",
    rows: 2,
    cols: 2,
    headerRowIds: ["table_0_r0_c0", "table_0_r0_c1"],
    cellSegmentIds: new Map([
      ["table_0_r0_c0", { row: 0, col: 0, role: "header" }],
      ["table_0_r0_c1", { row: 0, col: 1, role: "header" }],
      ["table_0_r1_c0", { row: 1, col: 0, role: "cell" }],
      ["table_0_r1_c1", { row: 1, col: 1, role: "cell" }],
    ]),
  };
}

describe("annotateSegmentsWithTableStructure", () => {
  it("annotates segments with table role", () => {
    const tables = [makeTableStructure()];
    const segments = [makeSegment("table_0_r0_c0", "Name"), makeSegment("table_0_r1_c0", "Test")];
    const annotated = annotateSegmentsWithTableStructure(segments, tables);
    expect(annotated[0].tableRole).toBe("header");
    expect(annotated[0].tableRow).toBe(0);
    expect(annotated[0].tableCol).toBe(0);
    expect(annotated[1].tableRole).toBe("cell");
    expect(annotated[1].tableRow).toBe(1);
    expect(annotated[1].tableCol).toBe(0);
  });

  it("leaves non-table segments unchanged", () => {
    const tables: TableStructure[] = [];
    const segments = [makeSegment("seg_0", "Hello")];
    const annotated = annotateSegmentsWithTableStructure(segments, tables);
    expect(annotated[0].tableRole).toBeUndefined();
  });

  it("handles row headers", () => {
    const table: TableStructure = {
      tableId: "table_0",
      rows: 2,
      cols: 2,
      headerRowIds: ["table_0_r0_c0"],
      cellSegmentIds: new Map([
        ["table_0_r0_c0", { row: 0, col: 0, role: "header" }],
        ["table_0_r1_c0", { row: 1, col: 0, role: "row-header" }],
        ["table_0_r1_c1", { row: 1, col: 1, role: "cell" }],
      ]),
    };
    const segments = [makeSegment("table_0_r1_c0", "RowHeader")];
    const annotated = annotateSegmentsWithTableStructure(segments, [table]);
    expect(annotated[0].tableRole).toBe("row-header");
  });
});

describe("formatTableContext", () => {
  it("returns context for table cells", () => {
    const tables = [makeTableStructure()];
    const segment = makeSegment("table_0_r1_c0", "Test");
    segment.tableRole = "cell";
    const context = formatTableContext(segment, tables);
    expect(context).toContain("Table table_0");
    expect(context).toContain("cell");
    expect(context).toContain("row 2");
    expect(context).toContain("col 1");
  });

  it("returns context for headers", () => {
    const tables = [makeTableStructure()];
    const segment = makeSegment("table_0_r0_c0", "Name");
    segment.tableRole = "header";
    const context = formatTableContext(segment, tables);
    expect(context).toContain("header");
    expect(context).toContain("row 1");
  });

  it("returns undefined for non-table segments", () => {
    const tables: TableStructure[] = [];
    const segment = makeSegment("seg_0", "Hello");
    const context = formatTableContext(segment, tables);
    expect(context).toBeUndefined();
  });
});
