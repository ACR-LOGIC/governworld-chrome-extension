// The document pipeline maps a detection back to page pixels through character
// offsets, and that mapping is only correct if two independent pieces of code
// agree on exactly how the OCR text is assembled:
//
//   1. ocr.ts        builds `fullText` from the token list, inserting a separator
//                    between tokens: "\n" when the line index changes, " " when
//                    it does not.
//   2. core.ts       `tokenSpans()` recomputes those same offsets with the same
//                    rule, so a match at [start, end) can be resolved to the
//                    rectangles of the tokens it covers.
//
// Nothing in the type system ties them together. Returning tesseract's own
// `data.text` from ocr.ts — which uses different spacing — keeps every unit test
// green while drawing redaction boxes over innocent content. That is exactly
// what happened when tesseract.js was upgraded to v7, and the only thing that
// caught it was the pixel-level photo E2E.
//
// So assert the invariant directly: for a synthetic page, every token span must
// index back to that token's own text in fullText.
import { describe, expect, it } from "vitest";
import { detect } from "../src/content/detect.js";
import { tokenSpans } from "../src/document-pipeline/core.js";
import type { OcrPageResult, OcrToken } from "../src/document-pipeline/ocr.js";

/** Mirrors the assembly in src/document-pipeline/ocr.ts. */
function assembleFullText(tokens: OcrToken[]): string {
  return tokens
    .map((t, i) => (i > 0 && t.lineIndex !== tokens[i - 1].lineIndex ? "\n" : i > 0 ? " " : "") + t.text)
    .join("");
}

const token = (text: string, lineIndex: number, y: number): OcrToken => ({
  text,
  confidence: 95,
  lineIndex,
  bbox: { x: 10, y, width: text.length * 8, height: 20 },
});

/** A page shaped like the photo fixture: six real values plus innocent prose. */
function syntheticPage(): OcrPageResult {
  const tokens: OcrToken[] = [
    token("ACTIVE", 0, 100),
    token("HEALTH", 0, 100),
    token("SERVICES", 0, 100),
    token("219-09-9999", 1, 448),
    token("Amount", 2, 1018),
    token("Due:", 2, 1018),
    token("$248.00", 2, 1017),
    token("Patient", 3, 1230),
    token("reports", 3, 1230),
    token("mild", 3, 1230),
    token("allergies.", 3, 1230),
    token("4111111111111111", 4, 948),
  ];
  return { pageIndex: 0, widthPx: 1240, heightPx: 1754, tokens, fullText: assembleFullText(tokens) };
}

describe("OCR text and token-offset coupling", () => {
  it("every token span indexes back to that token's text in fullText", () => {
    const page = syntheticPage();
    const spans = tokenSpans(page.tokens);
    expect(spans).toHaveLength(page.tokens.length);
    for (let i = 0; i < spans.length; i++) {
      const { start, end, token: t } = spans[i];
      expect(page.fullText.slice(start, end), `token ${i} ("${t.text}") does not slice back to itself`).toBe(t.text);
    }
  });

  it("spans are contiguous and non-overlapping in reading order", () => {
    const page = syntheticPage();
    const spans = tokenSpans(page.tokens);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
    expect(spans[spans.length - 1].end).toBe(page.fullText.length);
  });

  it("uses a newline exactly where the line index changes", () => {
    const page = syntheticPage();
    const spans = tokenSpans(page.tokens);
    for (let i = 1; i < spans.length; i++) {
      const sameLine = page.tokens[i].lineIndex === page.tokens[i - 1].lineIndex;
      const gap = page.fullText.slice(spans[i - 1].end, spans[i].start);
      expect(gap, `between token ${i - 1} and ${i}`).toBe(sameLine ? " " : "\n");
    }
  });

  it("resolves a real detection to the rectangle of the token it covers", () => {
    const page = syntheticPage();
    const spans = tokenSpans(page.tokens);
    const match = detect(page.fullText, ["ssn", "payment_card", "email", "phone"], []).find(
      (m) => m.value === "219-09-9999",
    );
    expect(match, "the SSN in the synthetic page must be detected").toBeDefined();

    // The match must resolve to tokens whose text is inside the matched span.
    const covered = spans.filter((s) => s.start >= match!.start && s.end <= match!.end);
    expect(covered.map((s) => s.token.text)).toEqual(["219-09-9999"]);
    // And the rectangle must be the SSN's, not some neighbouring token's.
    expect(covered[0].token.bbox.y).toBe(448);
  });

  it("a match never resolves to a token outside the matched span", () => {
    const page = syntheticPage();
    const spans = tokenSpans(page.tokens);
    const matches = detect(page.fullText, ["ssn", "payment_card", "email", "phone"], []);
    for (const m of matches) {
      const text = page.fullText.slice(m.start, m.end);
      for (const s of spans) {
        if (s.start >= m.start && s.end <= m.end) {
          // A covered token must lie within the matched characters.
          expect(text).toContain(s.token.text);
        }
      }
    }
  });

  it("an innocent amount is not detected, so it can never be boxed", () => {
    // This is the exact text the tesseract v7 upgrade caused a box over. If a
    // future detector change starts matching it, this fails and the pixel-level
    // E2E expectation in tests/fixtures/photo-pii.regions.json must be revisited
    // deliberately rather than by accident.
    const page = syntheticPage();
    const matches = detect(page.fullText, ["ssn", "payment_card", "email", "phone", "dob", "member_id"], []);
    expect(matches.map((m) => m.value)).not.toContain("$248.00");
    expect(matches.map((m) => m.value)).not.toContain("248.00");
  });
});
