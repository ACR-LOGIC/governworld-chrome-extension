// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { SUPPORTED_OCR_LANGUAGES } from "../src/document-pipeline/ocr.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings.js";
import { scaleBox } from "../src/document-pipeline/render.js";
import type { Finding, Rect } from "../src/shared/types.js";

describe("Document Studio Interactive Math & Hit Testing", () => {
  const pageMeta = {
    index: 0,
    widthPx: 1200,
    heightPx: 1600,
  };

  const canvasWidth = 300;
  const canvasHeight = 400;

  it("accurately converts canvas click coordinates to full-resolution page coordinates", () => {
    const scaleX = canvasWidth / pageMeta.widthPx; // 0.25
    const scaleY = canvasHeight / pageMeta.heightPx; // 0.25

    // User clicks at (100, 150) on the 300x400 thumbnail canvas
    const clickX = 100;
    const clickY = 150;

    const pageX = clickX / scaleX;
    const pageY = clickY / scaleY;

    expect(pageX).toBe(400);
    expect(pageY).toBe(600);
  });

  it("hit-tests existing finding boxes correctly", () => {
    const finding1: Finding = {
      id: "f1",
      category: "email",
      confidence: 0.95,
      source: "local-rules",
      preview: "j***@example.com",
      nodeId: "",
      startOffset: 0,
      endOffset: 16,
      rects: [{ x: 100, y: 200, width: 300, height: 50 }],
      selected: true,
    };

    const finding2: Finding = {
      id: "f2",
      category: "ssn",
      confidence: 0.99,
      source: "local-rules",
      preview: "***-**-6789",
      nodeId: "",
      startOffset: 20,
      endOffset: 31,
      rects: [{ x: 500, y: 700, width: 250, height: 40 }],
      selected: true,
    };

    const findings = [finding1, finding2];

    const hitTest = (px: number, py: number): Finding | null => {
      for (let i = findings.length - 1; i >= 0; i--) {
        const f = findings[i];
        for (const r of f.rects) {
          if (px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height) {
            return f;
          }
        }
      }
      return null;
    };

    // Point inside finding1 (e.g. 200, 220)
    expect(hitTest(200, 220)?.id).toBe("f1");

    // Point inside finding2 (e.g. 600, 710)
    expect(hitTest(600, 710)?.id).toBe("f2");

    // Point outside both (e.g. 50, 50)
    expect(hitTest(50, 50)).toBeNull();
  });

  it("converts a drawn rectangle on thumbnail canvas to full-page custom finding", () => {
    const scaleX = canvasWidth / pageMeta.widthPx; // 0.25
    const scaleY = canvasHeight / pageMeta.heightPx; // 0.25

    // Drawn drag box on thumbnail canvas: (50, 100) -> (150, 200) (w: 100, h: 100)
    const dragBox = { x: 50, y: 100, width: 100, height: 100 };

    const customRect: Rect = {
      x: Math.round(dragBox.x / scaleX),
      y: Math.round(dragBox.y / scaleY),
      width: Math.round(dragBox.width / scaleX),
      height: Math.round(dragBox.height / scaleY),
    };

    expect(customRect).toEqual({
      x: 200,
      y: 400,
      width: 400,
      height: 400,
    });

    const customFinding: Finding = {
      id: "custom:test-uuid-1",
      category: "custom",
      confidence: 1.0,
      source: "custom-pattern",
      preview: "[Custom Redaction]",
      nodeId: "",
      startOffset: 0,
      endOffset: 0,
      rects: [customRect],
      contextPreview: `Drawn bounding box (${customRect.width}×${customRect.height}px)`,
      selected: true,
    };

    expect(customFinding.category).toBe("custom");
    expect(customFinding.id.startsWith("custom:")).toBe(true);
    expect(customFinding.selected).toBe(true);
  });

  it("scaleBox helper scales rects accurately", () => {
    const box: Rect = { x: 100, y: 200, width: 300, height: 50 };
    const scaled = scaleBox(box, 0.5, 0.5);
    expect(scaled).toEqual({ x: 50, y: 100, width: 150, height: 25 });
  });
});

describe("Multi-Language OCR Architecture", () => {
  it("includes all supported language codes in SUPPORTED_OCR_LANGUAGES", () => {
    expect(SUPPORTED_OCR_LANGUAGES).toContain("eng");
    expect(SUPPORTED_OCR_LANGUAGES).toContain("spa");
    expect(SUPPORTED_OCR_LANGUAGES).toContain("fra");
    expect(SUPPORTED_OCR_LANGUAGES).toContain("deu");
    expect(SUPPORTED_OCR_LANGUAGES).toContain("jpn");
    expect(SUPPORTED_OCR_LANGUAGES).toContain("por");
  });

  it("defaults to 'eng' in DEFAULT_SETTINGS", () => {
    expect(DEFAULT_SETTINGS.ocrLanguage).toBe("eng");
  });

  it("normalizes settings and preserves valid OCR languages", () => {
    const s1 = normalizeSettings({ ocrLanguage: "spa" });
    expect(s1.ocrLanguage).toBe("spa");

    const s2 = normalizeSettings({ ocrLanguage: "jpn" });
    expect(s2.ocrLanguage).toBe("jpn");

    const s3 = normalizeSettings({ ocrLanguage: "invalid_lang" });
    expect(s3.ocrLanguage).toBe("eng");

    const s4 = normalizeSettings({});
    expect(s4.ocrLanguage).toBe("eng");
  });
});
