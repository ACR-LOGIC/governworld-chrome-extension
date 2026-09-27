// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, beforeEach } from "vitest";
import { applyBoxes } from "../src/document-pipeline/render.js";
import { verifyCanvasRegions, REDACTION_DARK_LUMINANCE, REDACTION_WHITE_LUMINANCE } from "../src/document-pipeline/verify.js";
import { normalizeRedactionOptions, validateMessage } from "../src/shared/messages.js";
import type { Rect, RedactionOptions } from "../src/shared/types.js";

// Minimal mock HTMLCanvasElement and CanvasRenderingContext2D for testing in Node.js environment
class MockCanvasRenderingContext2D {
  canvas: MockCanvas;
  fillStyle: string = "#000000";
  strokeStyle: string = "#000000";
  font: string = "10px sans-serif";
  textAlign: string = "start";
  textBaseline: string = "alphabetic";
  lineWidth: number = 1;
  private stateStack: any[] = [];
  drawnRects: { x: number; y: number; width: number; height: number; fillStyle: string }[] = [];
  drawnTexts: { text: string; x: number; y: number; fillStyle: string }[] = [];

  constructor(canvas: MockCanvas) {
    this.canvas = canvas;
  }

  save() {
    this.stateStack.push({
      fillStyle: this.fillStyle,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    });
  }

  restore() {
    const state = this.stateStack.pop();
    if (state) {
      this.fillStyle = state.fillStyle;
      this.font = state.font;
      this.textAlign = state.textAlign;
      this.textBaseline = state.textBaseline;
    }
  }

  fillRect(x: number, y: number, width: number, height: number) {
    this.drawnRects.push({ x, y, width, height, fillStyle: this.fillStyle });
    // Paint pixels in canvas pixel buffer
    const isWhite = this.fillStyle === "#ffffff" || this.fillStyle.toLowerCase() === "rgb(255, 255, 255)";
    const val = isWhite ? 255 : 0;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.canvas.width, Math.ceil(x + width));
    const y1 = Math.min(this.canvas.height, Math.ceil(y + height));

    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const idx = (cy * this.canvas.width + cx) * 4;
        this.canvas.pixelData[idx] = val;
        this.canvas.pixelData[idx + 1] = val;
        this.canvas.pixelData[idx + 2] = val;
        this.canvas.pixelData[idx + 3] = 255;
      }
    }
  }

  strokeRect(_x: number, _y: number, _w: number, _h: number) {}
  setLineDash(_dash: number[]) {}

  fillText(text: string, x: number, y: number) {
    this.drawnTexts.push({ text, x, y, fillStyle: this.fillStyle });
    // Stamp text writes text pixels into the center
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const isWhiteText = this.fillStyle === "#ffffff";
    const textVal = isWhiteText ? 255 : 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const px = cx + dx;
        const py = cy + dy;
        if (px >= 0 && px < this.canvas.width && py >= 0 && py < this.canvas.height) {
          const idx = (py * this.canvas.width + px) * 4;
          this.canvas.pixelData[idx] = textVal;
          this.canvas.pixelData[idx + 1] = textVal;
          this.canvas.pixelData[idx + 2] = textVal;
          this.canvas.pixelData[idx + 3] = 255;
        }
      }
    }
  }

  getImageData(sx: number, sy: number, sw: number, sh: number) {
    const data = new Uint8ClampedArray(sw * sh * 4);
    let di = 0;
    for (let y = sy; y < sy + sh; y++) {
      for (let x = sx; x < sx + sw; x++) {
        if (x >= 0 && x < this.canvas.width && y >= 0 && y < this.canvas.height) {
          const srcIdx = (y * this.canvas.width + x) * 4;
          data[di] = this.canvas.pixelData[srcIdx];
          data[di + 1] = this.canvas.pixelData[srcIdx + 1];
          data[di + 2] = this.canvas.pixelData[srcIdx + 2];
          data[di + 3] = this.canvas.pixelData[srcIdx + 3];
        } else {
          data[di] = 255;
          data[di + 1] = 255;
          data[di + 2] = 255;
          data[di + 3] = 255;
        }
        di += 4;
      }
    }
    return { data };
  }
}

class MockCanvas {
  width: number;
  height: number;
  pixelData: Uint8ClampedArray;
  private ctx: MockCanvasRenderingContext2D;

  constructor(width = 200, height = 200) {
    this.width = width;
    this.height = height;
    // Initial background: light gray / white (240)
    this.pixelData = new Uint8ClampedArray(width * height * 4);
    this.pixelData.fill(240);
    this.ctx = new MockCanvasRenderingContext2D(this);
  }

  getContext(contextId: string) {
    if (contextId === "2d") return this.ctx;
    return null;
  }
}

describe("Redaction Styles & Rendering", () => {
  let canvas: MockCanvas;

  beforeEach(() => {
    canvas = new MockCanvas(300, 300);
  });

  it("applies default blackout style with solid black rectangle", () => {
    const box: Rect = { x: 50, y: 50, width: 80, height: 20 };
    applyBoxes(canvas as unknown as HTMLCanvasElement, [box]);

    const ctx = canvas.getContext("2d") as unknown as MockCanvasRenderingContext2D;
    expect(ctx.drawnRects).toHaveLength(1);
    expect(ctx.drawnRects[0].fillStyle).toBe("#000000");
    // Default padding is 4px
    expect(ctx.drawnRects[0].x).toBe(46);
    expect(ctx.drawnRects[0].y).toBe(46);
    expect(ctx.drawnRects[0].width).toBe(88);
    expect(ctx.drawnRects[0].height).toBe(28);
  });

  it("applies whiteout style with solid white rectangle", () => {
    const box: Rect = { x: 40, y: 40, width: 100, height: 30 };
    applyBoxes(canvas as unknown as HTMLCanvasElement, [box], { style: "whiteout" });

    const ctx = canvas.getContext("2d") as unknown as MockCanvasRenderingContext2D;
    expect(ctx.drawnRects).toHaveLength(1);
    expect(ctx.drawnRects[0].fillStyle).toBe("#ffffff");
    expect(ctx.drawnTexts).toHaveLength(0);
  });

  it("applies stamp style with default [REDACTED] centered text stamp", () => {
    const box: Rect = { x: 30, y: 30, width: 120, height: 40 };
    applyBoxes(canvas as unknown as HTMLCanvasElement, [box], { style: "stamp" });

    const ctx = canvas.getContext("2d") as unknown as MockCanvasRenderingContext2D;
    expect(ctx.drawnRects).toHaveLength(1);
    expect(ctx.drawnRects[0].fillStyle).toBe("#000000");
    expect(ctx.drawnTexts).toHaveLength(1);
    expect(ctx.drawnTexts[0].text).toBe("[REDACTED]");
    expect(ctx.drawnTexts[0].fillStyle).toBe("#ffffff");
  });

  it("applies custom stamp label and custom padding", () => {
    const box: Rect = { x: 60, y: 60, width: 100, height: 30 };
    applyBoxes(canvas as unknown as HTMLCanvasElement, [box], {
      style: "stamp",
      stampText: "CONFIDENTIAL",
      padding: 8,
    });

    const ctx = canvas.getContext("2d") as unknown as MockCanvasRenderingContext2D;
    expect(ctx.drawnRects[0].x).toBe(52);
    expect(ctx.drawnRects[0].y).toBe(52);
    expect(ctx.drawnRects[0].width).toBe(116);
    expect(ctx.drawnRects[0].height).toBe(46);
    expect(ctx.drawnTexts[0].text).toBe("CONFIDENTIAL");
  });

  it("supports explicit fillColor override", () => {
    const box: Rect = { x: 20, y: 20, width: 60, height: 20 };
    applyBoxes(canvas as unknown as HTMLCanvasElement, [box], {
      fillColor: "#ffffff",
      stampText: "RESTRICTED",
    });

    const ctx = canvas.getContext("2d") as unknown as MockCanvasRenderingContext2D;
    expect(ctx.drawnRects[0].fillStyle).toBe("#ffffff");
    expect(ctx.drawnTexts[0].fillStyle).toBe("#000000");
    expect(ctx.drawnTexts[0].text).toBe("RESTRICTED");
  });
});

describe("Post-Redaction Verification for Custom Styles", () => {
  let canvas: MockCanvas;

  beforeEach(() => {
    canvas = new MockCanvas(200, 200);
  });

  it("verifies blackout regions with high dark fraction", () => {
    const box: Rect = { x: 20, y: 20, width: 60, height: 30 };
    applyBoxes(canvas as unknown as HTMLCanvasElement, [box], { style: "blackout", padding: 2 });

    const result = verifyCanvasRegions(canvas as unknown as HTMLCanvasElement, [box], 2, "test", { style: "blackout" });
    expect(result.checked).toBe(1);
    expect(result.dark).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it("verifies whiteout regions with white luminance checks", () => {
    const box: Rect = { x: 30, y: 30, width: 50, height: 25 };
    applyBoxes(canvas as unknown as HTMLCanvasElement, [box], { style: "whiteout", padding: 2 });

    const result = verifyCanvasRegions(canvas as unknown as HTMLCanvasElement, [box], 2, "test", { style: "whiteout" });
    expect(result.checked).toBe(1);
    expect(result.dark).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it("verifies stamp regions allowing lower coverage fraction for centered text", () => {
    const box: Rect = { x: 40, y: 40, width: 80, height: 30 };
    applyBoxes(canvas as unknown as HTMLCanvasElement, [box], { style: "stamp", stampText: "[REDACTED]", padding: 2 });

    const result = verifyCanvasRegions(canvas as unknown as HTMLCanvasElement, [box], 2, "test", { style: "stamp" });
    expect(result.checked).toBe(1);
    expect(result.dark).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it("reports failure when a region is uncovered", () => {
    const box: Rect = { x: 50, y: 50, width: 40, height: 20 };
    // We do NOT call applyBoxes, so canvas remains background (240)
    const result = verifyCanvasRegions(canvas as unknown as HTMLCanvasElement, [box], 2, "test-page", { style: "blackout" });
    expect(result.checked).toBe(1);
    expect(result.dark).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("is only 0.0% covered");
  });
});

describe("Message contract & normalization for RedactionOptions", () => {
  it("normalizes undefined or empty options safely", () => {
    expect(normalizeRedactionOptions(undefined)).toBeUndefined();
    expect(normalizeRedactionOptions(null)).toBeUndefined();
    expect(normalizeRedactionOptions("invalid")).toBeUndefined();
  });

  it("normalizes whiteout style and custom fields", () => {
    const opt = normalizeRedactionOptions({ style: "whiteout", fillColor: "#ffffff", padding: 5 });
    expect(opt).toBeDefined();
    expect(opt?.style).toBe("whiteout");
    expect(opt?.fillColor).toBe("#ffffff");
    expect(opt?.padding).toBe(5);
  });

  it("normalizes stamp style and stampText label", () => {
    const opt = normalizeRedactionOptions({ style: "stamp", stampText: "[REDACTED]" });
    expect(opt).toBeDefined();
    expect(opt?.style).toBe("stamp");
    expect(opt?.stampText).toBe("[REDACTED]");
  });

  it("validates POPUP_DOC_REDACT message with options", () => {
    const msg = {
      type: "POPUP_DOC_REDACT",
      requestId: "req-123",
      docId: "doc-1",
      fileKey: "key-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
      boxes: [{ pageIndex: 0, rects: [{ x: 10, y: 10, width: 50, height: 20 }] }],
      findingIds: ["f1"],
      options: {
        style: "stamp",
        stampText: "INTERNAL ONLY",
        padding: 6,
      },
    };

    const validated = validateMessage(msg);
    expect(validated.ok).toBe(true);
    if (validated.ok && validated.message.type === "POPUP_DOC_REDACT") {
      expect(validated.message.options?.style).toBe("stamp");
      expect(validated.message.options?.stampText).toBe("INTERNAL ONLY");
      expect(validated.message.options?.padding).toBe(6);
    }
  });
});
