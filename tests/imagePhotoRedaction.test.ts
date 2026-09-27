// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Proves the photo/image path end to end at the level that matters for a user
// holding up a photograph of a document:
//
//   image bytes -> canvas -> OCR words -> local detectors -> positioned rects
//                                                    -> black boxes on the pixels
//
// The existing suite proves token offset math and a single-token email. This
// file covers the realistic photograph case: many words at varying positions on
// several lines, a sensitive value split across word boundaries, and values
// that must NOT be flagged. Without this, "it redacts photos" is a claim about
// code shape rather than behaviour.
//
// OCR itself is browser-bound (Worker + chrome.runtime.getURL) and is proved
// separately by `npm run test:offline-ocr`; this file drives the deterministic
// half — the mapping from recognized words to pixel rectangles.
import { describe, it, expect } from "vitest";
import { findingsFromOcrPages } from "../src/document-pipeline/core.js";
import type { OcrPageResult, OcrToken } from "../src/document-pipeline/ocr.js";
import { applyBoxes } from "../src/document-pipeline/render.js";

/** A recognized word with a real position on the page. */
function word(text: string, lineIndex: number, x: number, y: number, width: number, height = 18): OcrToken {
  return { text, confidence: 88, lineIndex, bbox: { x, y, width, height } };
}

/** Reconstruct the fullText exactly as ocr.ts joins tokens (newline per line). */
function joinTokens(tokens: OcrToken[]): string {
  return tokens
    .map((t, i) => (i > 0 && t.lineIndex !== tokens[i - 1].lineIndex ? "\n" : i > 0 ? " " : "") + t.text)
    .join("");
}

function photoPage(tokens: OcrToken[], widthPx = 1600, heightPx = 1200): OcrPageResult {
  return { pageIndex: 0, widthPx, heightPx, tokens, fullText: joinTokens(tokens) };
}

const ALL_CATEGORIES = [
  "email",
  "phone",
  "ssn",
  "dob",
  "medical_record_number",
  "member_id",
  "npi",
  "dea",
  "mbi",
  "address",
  "payment_card",
  "secrets",
  "possible_name",
  "custom"
] as const;

/** Every category the extension ships, so nothing is silently disabled. */
const categories = [...ALL_CATEGORIES];

describe("a photo of a document yields positioned, redactable rects", () => {
  it("finds an SSN on a later line and places the rect where the words actually are", () => {
    //        line 0 (header)                line 1 (the SSN, indented)
    const tokens = [
      word("PATIENT", 0, 100, 80, 70),
      word("RECORD", 0, 180, 80, 75),
      word("SSN:", 1, 100, 200, 34),
      word("123-45-6789", 1, 145, 200, 105)
    ];
    const findings = findingsFromOcrPages([photoPage(tokens)], categories);

    const ssn = findings.find((f) => f.category === "ssn");
    expect(ssn, "the SSN in the photo must be detected").toBeDefined();
    expect(ssn!.rects.length).toBeGreaterThan(0);

    // The rect must sit on the SSN line, not the header line.
    const rect = ssn!.rects[0]!;
    expect(rect.y).toBe(200);
    expect(rect.y).toBeGreaterThanOrEqual(200);
    // It must cover the digits, starting at the token's x.
    expect(rect.x).toBeLessThanOrEqual(145);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(145 + 105);
  });

  it("flags a card number even when OCR splits it into several word tokens", () => {
    // Real photos split a long number across tokens; the merge must rejoin them.
    const tokens = [
      word("Card", 0, 40, 40, 40),
      word("4111", 1, 40, 90, 46),
      word("1111", 1, 92, 90, 46),
      word("1111", 1, 144, 90, 46),
      word("1111", 1, 196, 90, 46)
    ];
    const findings = findingsFromOcrPages([photoPage(tokens)], categories);
    const card = findings.find((f) => f.category === "payment_card");
    expect(card, "a card number split across tokens must still be detected").toBeDefined();
    expect(card!.rects.length).toBeGreaterThan(0);
  });

  it("keeps every finding rect inside the page bounds", () => {
    const tokens = [
      word("Email", 0, 20, 20, 45),
      word("patient@clinic.org", 0, 70, 20, 160),
      word("SSN", 1, 20, 60, 30),
      word("078-05-1120", 1, 55, 60, 95)
    ];
    const page = photoPage(tokens, 1600, 1200);
    const findings = findingsFromOcrPages([page], categories);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      for (const rect of finding.rects) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(page.widthPx);
        expect(rect.y + rect.height).toBeLessThanOrEqual(page.heightPx);
      }
    }
  });

  it("returns rects that the renderer will actually paint on the photo pixels", () => {
    const tokens = [word("SSN", 0, 30, 30, 32), word("123-45-6789", 0, 70, 30, 100)];
    const findings = findingsFromOcrPages([photoPage(tokens)], categories);
    const rects = findings.flatMap((f) => f.rects);
    expect(rects.length).toBeGreaterThan(0);

    // Drive the real painter: every rect must become a fill on the canvas.
    const fills: Array<{ x: number; y: number; w: number; h: number }> = [];
    const canvas = {
      width: 1600,
      height: 1200,
      getContext: () => ({
        fillStyle: "",
        fillRect(x: number, y: number, w: number, h: number) {
          fills.push({ x, y, w, h });
        }
      })
    } as unknown as HTMLCanvasElement;

    applyBoxes(canvas, rects);
    expect(fills.length).toBe(rects.length);
    for (const fill of fills) {
      expect(fill.w).toBeGreaterThan(0);
      expect(fill.h).toBeGreaterThan(0);
    }
  });

  it("does not flag ordinary prose in a photo", () => {
    const tokens = [
      word("This", 0, 20, 20, 40),
      word("invoice", 0, 65, 20, 60),
      word("is", 0, 130, 20, 18),
      word("for", 0, 153, 20, 25),
      word("services", 0, 183, 20, 70),
      word("rendered", 0, 258, 20, 75),
      word("in", 0, 338, 20, 18),
      word("March", 0, 361, 20, 55)
    ];
    expect(findingsFromOcrPages([photoPage(tokens)], categories)).toEqual([]);
  });

  it("finds nothing when the photo has no text at all", () => {
    expect(findingsFromOcrPages([photoPage([])], categories)).toEqual([]);
  });

  it("separates findings by page so multi-page documents redact independently", () => {
    const makePage = (index: number, ssn: string) => {
      const tokens = [word("SSN", 0, 20, 20, 32), word(ssn, 0, 60, 20, 100)];
      return { ...photoPage(tokens), pageIndex: index };
    };
    const findings = findingsFromOcrPages([makePage(0, "111-22-3333"), makePage(1, "444-55-6666")], categories);
    const pages = new Set(findings.map((f) => f.nodeId));
    expect(pages.size).toBe(2);
    expect(findings.every((f) => f.rects.length > 0)).toBe(true);
  });

  it("honours the enabled category set from Custom mode", () => {
    const tokens = [
      word("SSN", 0, 20, 20, 32),
      word("123-45-6789", 0, 60, 20, 100),
      word("Email", 1, 20, 60, 42),
      word("a@b.com", 1, 68, 60, 70)
    ];
    const page = photoPage(tokens);
    // Only SSN enabled -> the email must not appear.
    const ssnOnly = findingsFromOcrPages([page], ["ssn"]);
    expect(ssnOnly.map((f) => f.category)).toEqual(["ssn"]);

    // Only email enabled -> the SSN must not appear.
    const emailOnly = findingsFromOcrPages([page], ["email"]);
    expect(emailOnly.map((f) => f.category)).toEqual(["email"]);
  });

  it("never returns the raw recognized text in a finding preview", () => {
    // Even though OCR produced the literal SSN, the surfaced preview must be
    // masked: recognized text must not travel as a value out of the pipeline.
    // SSN masking deliberately keeps the last four digits (the non-identifying
    // portion); the area and identifier are what must not survive.
    const tokens = [word("123-45-6789", 0, 20, 20, 100)];
    const findings = findingsFromOcrPages([photoPage(tokens)], categories);
    expect(findings.length).toBe(1);
    const preview = findings[0]!.preview;
    expect(preview).not.toContain("123-45-6789");
    expect(preview).not.toContain("123");
    expect(preview).not.toContain("45");
    expect(preview).toContain("*");
  });

  it("masks a recognized email in a photo without losing the domain", () => {
    const tokens = [word("jane.doe@clinic.org", 0, 20, 20, 190)];
    const findings = findingsFromOcrPages([photoPage(tokens)], categories);
    const email = findings.find((f) => f.category === "email");
    expect(email).toBeDefined();
    // Local part is masked; the domain survives so the reviewer can tell which
    // clinician/clinic this belongs to.
    expect(email!.preview).not.toContain("jane.doe");
    expect(email!.preview).toContain("@clinic.org");
  });
});
