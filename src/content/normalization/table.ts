// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { CanonicalSegment } from "./types.js";

export interface TableStructure {
  tableId: string;
  rows: number;
  cols: number;
  headerRowIds: string[];
  cellSegmentIds: Map<string, { row: number; col: number; role: "header" | "cell" | "row-header" }>;
}

export function extractTableStructures(root: Document | Element | ShadowRoot): TableStructure[] {
  const tables: TableStructure[] = [];
  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const tableElements = doc.querySelectorAll("table");

  for (let t = 0; t < tableElements.length; t++) {
    const table = tableElements[t];
    const tableId = `table_${t}`;
    const rows = table.querySelectorAll("tr");
    const cellSegmentIds = new Map<string, { row: number; col: number; role: "header" | "cell" | "row-header" }>();
    const headerRowIds: string[] = [];
    let maxCols = 0;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const cells = row.querySelectorAll("th, td");
      maxCols = Math.max(maxCols, cells.length);

      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c];
        const role: "header" | "cell" | "row-header" = cell.tagName === "TH" ? (r === 0 ? "header" : "row-header") : "cell";
        const cellId = `${tableId}_r${r}_c${c}`;
        cellSegmentIds.set(cellId, { row: r, col: c, role });

        if (role === "header" && !headerRowIds.includes(cellId)) {
          headerRowIds.push(cellId);
        }
      }
    }

    tables.push({
      tableId,
      rows: rows.length,
      cols: maxCols,
      headerRowIds,
      cellSegmentIds,
    });
  }

  return tables;
}

export function annotateSegmentsWithTableStructure(
  segments: CanonicalSegment[],
  tables: TableStructure[]
): CanonicalSegment[] {
  const annotated = [...segments];

  for (const table of tables) {
    for (const seg of annotated) {
      const nodeId = seg.nodeId;
      for (const [cellId, info] of table.cellSegmentIds) {
        if (nodeId.includes(cellId) || cellId.includes(nodeId)) {
          seg.tableRole = info.role;
          seg.tableRow = info.row;
          seg.tableCol = info.col;
          break;
        }
      }
    }
  }

  return annotated;
}

export function formatTableContext(segment: CanonicalSegment, tables: TableStructure[]): string | undefined {
  if (!segment.tableRole) return undefined;

  for (const table of tables) {
    const info = table.cellSegmentIds.get(segment.nodeId);
    if (info) {
      const roleLabel = info.role === "header" ? "header" : info.role === "row-header" ? "row header" : "cell";
      return `Table ${table.tableId}, ${roleLabel}, row ${info.row + 1}, col ${info.col + 1}`;
    }
  }

  return undefined;
}
