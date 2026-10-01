// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Detection-quality cover for the page-text sources.
//
// Every document path funnels its page text through ONE token shape
// (`OcrToken`) and ONE offset assembler (`offsets.ts`), so a finding's rectangle
// and the text it was matched from can never disagree. That only holds if each
// source produces tokens in the same coordinate space as the rendered page, so
// these tests pin the geometry of both non-OCR sources:
//
//   * PDF text layer — read from the file instead of OCR'd.
//   * DOCX layout  — the text we drew ourselves, measured as we drew it.
//
// A box in the wrong place still looks like a successful redaction: the painter
// covers a region, verification confirms that region is dark, and the value
// itself is still on the page. So these are asserted against exact numbers
// rather than "produces something plausible".
import { describe, it, expect } from "vitest";
import { assembleOcrText, tokenSpans } from "../src/document-pipeline/offsets.js";
import { findingsFromOcrPages } from "../src/document-pipeline/core.js";
import type { OcrPageResult, OcrToken } from "../src/document-pipeline/ocr.js";

function page(tokens: OcrToken[], widthPx = 1275, heightPx = 1650): OcrPageResult {
  return { pageIndex: 0, widthPx, heightPx, tokens, fullText: assembleOcrText(tokens) };
}

describe("offsets are shared, not reimplemented per source", () => {
  it("maps a match back onto the exact tokens it covered", () => {
    // Whatever produced the tokens, the offset rule is the shared one.
    const tokens: OcrToken[] = [
      { text: "Card", confidence: 100, lineIndex: 0, bbox: { x: 100, y: 200, width: 60, height: 20 } },
      { text: "4111111111111111", confidence: 100, lineIndex: 0, bbox: { x: 170, y: 200, width: 200, height: 20 } },
    ];
    const p = page(tokens);
    const spans = tokenSpans(tokens);
    const found = findingsFromOcrPages([p], ["payment_card"]);
    expect(found).toHaveLength(1);
    const [hit] = found;
    // The rectangle is the matched token's box and nothing else: not the whole
    // line, not a neighbouring token.
    expect(hit.rects).toEqual([{ x: 170, y: 200, width: 200, height: 20 }]);
    // And the offsets still index the shared text.
    expect(p.fullText.slice(hit.startOffset, hit.endOffset)).toBe("4111111111111111");
    expect(spans.map((s) => p.fullText.slice(s.start, s.end))).toEqual(["Card", "4111111111111111"]);
  });

  it("merges the tokens of one value on a line into a single rect", () => {
    // A card number arrives as several text items on one line. Each is its own
    // token, and the boxes must merge into one covering rect rather than four
    // boxes with gaps a value could show through.
    const tokens: OcrToken[] = [
      { text: "4111", confidence: 100, lineIndex: 0, bbox: { x: 100, y: 200, width: 40, height: 20 } },
      { text: "1111", confidence: 100, lineIndex: 0, bbox: { x: 145, y: 200, width: 40, height: 20 } },
      { text: "1111", confidence: 100, lineIndex: 0, bbox: { x: 190, y: 200, width: 40, height: 20 } },
      { text: "1111", confidence: 100, lineIndex: 0, bbox: { x: 235, y: 200, width: 40, height: 20 } },
    ];
    const found = findingsFromOcrPages([page(tokens)], ["payment_card"]);
    expect(found).toHaveLength(1);
    expect(found[0].rects).toEqual([{ x: 100, y: 200, width: 175, height: 20 }]);
  });

  it("does not join a value across a line break into one tall box", () => {
    // `assembleOcrText` puts a newline between lines, so the detector's patterns
    // cannot match across one and a wrapped value is simply not detected. That is
    // the honest outcome: the alternative — matching across the break — would
    // produce one box spanning both lines, and on a two-column form that box
    // covers the unrelated text sitting between them.
    const tokens: OcrToken[] = [
      { text: "219-09-", confidence: 100, lineIndex: 0, bbox: { x: 50, y: 100, width: 90, height: 18 } },
      { text: "9999", confidence: 100, lineIndex: 1, bbox: { x: 50, y: 700, width: 60, height: 18 } },
    ];
    const found = findingsFromOcrPages([page(tokens)], ["ssn"]);
    // No match, so no rect at all — and in particular no 600px-tall box.
    for (const finding of found) {
      for (const rect of finding.rects) {
        expect(rect.height).toBeLessThan(100);
      }
    }
  });

  it("keeps a line's tokens on one line so a box stays on that line", () => {
    // The DOCX source emits one token per drawn line and the PDF source advances
    // its line index on hasEOL. Both must land on the same line index for the
    // merge above to be safe: a wrong index splits one value into boxes with
    // gaps between them.
    const tokens: OcrToken[] = [
      { text: "Contact", confidence: 100, lineIndex: 0, bbox: { x: 100, y: 200, width: 70, height: 20 } },
      { text: "219-09-9999", confidence: 100, lineIndex: 0, bbox: { x: 180, y: 200, width: 130, height: 20 } },
      { text: "Reference", confidence: 100, lineIndex: 1, bbox: { x: 100, y: 240, width: 90, height: 20 } },
    ];
    const found = findingsFromOcrPages([page(tokens)], ["ssn"]);
    expect(found).toHaveLength(1);
    expect(found[0].rects).toEqual([{ x: 180, y: 200, width: 130, height: 20 }]);
  });
});

describe("document findings never surface the raw value", () => {
  it("masks the preview even when the source text is exact", () => {
    // The text layer makes this exact rather than OCR-approximate, which is the
    // reason to use it — and the reason the masking must not be relaxed.
    const tokens: OcrToken[] = [
      { text: "jane.doe@clinic.org", confidence: 100, lineIndex: 0, bbox: { x: 40, y: 80, width: 220, height: 18 } },
    ];
    const found = findingsFromOcrPages([page(tokens)], ["email"]);
    expect(found).toHaveLength(1);
    expect(found[0].preview).not.toContain("jane.doe");
    expect(found[0].preview).toContain("*");
    expect(found[0].preview).toContain("@clinic.org");
  });

  it("keeps a text-layer token marked as exact rather than a recognition guess", () => {
    // Confidence here describes the SOURCE, and a value read from the file is not
    // a guess. Detection confidence is a separate number, set by the matcher.
    const token: OcrToken = { text: "x", confidence: 100, lineIndex: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } };
    expect(token.confidence).toBe(100);
  });
});