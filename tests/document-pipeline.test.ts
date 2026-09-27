// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { tokenSpans, findingsFromOcrPages } from "../src/document-pipeline/core.js";
import type { OcrPageResult, OcrToken } from "../src/document-pipeline/ocr.js";
import { assertSafeDocxArchive } from "../src/document-pipeline/docx.js";

function token(text: string, lineIndex: number, x: number, width: number): OcrToken {
  return { text, confidence: 90, lineIndex, bbox: { x, y: 10, width, height: 16 } };
}

function page(tokens: OcrToken[], widthPx = 800, heightPx = 1000): OcrPageResult {
  return {
    pageIndex: 0,
    widthPx,
    heightPx,
    tokens,
    fullText: tokens
      .map((t, i) => (i > 0 && t.lineIndex !== tokens[i - 1].lineIndex ? "\n" : i > 0 ? " " : "") + t.text)
      .join(""),
  };
}

describe("tokenSpans", () => {
  it("reconstructs offsets that match the joined fullText exactly", () => {
    const tokens = [token("Contact", 0, 0, 40), token("jane@example.com", 0, 41, 90), token("today", 0, 132, 30)];
    const p = page(tokens);
    const spans = tokenSpans(tokens);
    expect(spans.map((s) => p.fullText.slice(s.start, s.end))).toEqual(["Contact", "jane@example.com", "today"]);
    expect(spans[1].start).toBe(8);
    expect(spans[1].end).toBe(24);
  });

  it("inserts a newline between lines so offsets stay deterministic", () => {
    const tokens = [token("A", 0, 0, 10), token("B", 1, 0, 10), token("C", 1, 11, 10)];
    const p = page(tokens);
    const spans = tokenSpans(tokens);
    expect(p.fullText).toBe("A\nB C");
    expect(spans[1].start).toBe(2);
    expect(spans[2].start).toBe(4);
  });
});

function docxArchive(uncompressedSize: number, compressedSize: number): ArrayBuffer {
  const nameLength = 11;
  const centralOffset = 0;
  const centralSize = 46 + nameLength;
  const eocdOffset = centralOffset + centralSize;
  const buffer = new ArrayBuffer(eocdOffset + 22);
  const view = new DataView(buffer);
  view.setUint32(centralOffset, 0x02014b50, true);
  view.setUint16(centralOffset + 28, nameLength, true);
  view.setUint32(centralOffset + 20, compressedSize, true);
  view.setUint32(centralOffset + 24, uncompressedSize, true);
  view.setUint32(eocdOffset, 0x06054b50, true);
  view.setUint16(eocdOffset + 10, 1, true);
  view.setUint32(eocdOffset + 12, centralSize, true);
  view.setUint32(eocdOffset + 16, centralOffset, true);
  return buffer;
}

describe("DOCX archive limits", () => {
  it("accepts a bounded archive", () => {
    expect(() => assertSafeDocxArchive(docxArchive(20, 10))).not.toThrow();
  });

  it("rejects an archive with an unsafe compression ratio", () => {
    expect(() => assertSafeDocxArchive(docxArchive(20_000, 10))).toThrow(/compression ratio/);
  });
});

describe("findingsFromOcrPages", () => {
  it("detects an email across tokens and maps it to the token rect", () => {
    const tokens = [token("Contact", 0, 0, 40), token("jane@example.com", 0, 41, 90), token("today", 0, 132, 30)];
    const findings = findingsFromOcrPages([page(tokens)], ["email"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("email");
    expect(findings[0].preview).toBe("j***@example.com");
    expect(findings[0].source).toBe("local-rules");
    expect(findings[0].rects).toEqual([{ x: 41, y: 10, width: 90, height: 16 }]);
  });

  it("returns no findings when the category is disabled", () => {
    const tokens = [token("SSN", 0, 0, 20), token("123-45-6789", 0, 21, 60)];
    const findings = findingsFromOcrPages([page(tokens)], ["email"]);
    expect(findings).toHaveLength(0);
  });

  it("prunes findings that cover only zero-area tokens", () => {
    const tokens = [token("123-45-6789", 0, 21, 0)];
    const findings = findingsFromOcrPages([page(tokens)], ["ssn"]);
    expect(findings).toHaveLength(0);
  });

  it("splits multi-line matches into separate rects", () => {
    const tokens = [token("jane@example.com", 0, 10, 90), token("jane@example.com", 1, 10, 90)];
    const p = page(tokens);
    const findings = findingsFromOcrPages([p], ["email"]);
    // Both occurrences are separate matches; each maps to its own line's rect.
    expect(findings).toHaveLength(2);
    expect(findings[0].rects).toEqual([{ x: 10, y: 10, width: 90, height: 16 }]);
    expect(findings[1].rects).toEqual([{ x: 10, y: 10, width: 90, height: 16 }]);
  });
});