// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Post-redaction verification.
//
// Producing bytes is not the same as redacting. A painter can silently no-op, a
// coordinate can be scaled wrong, an encoder can drop a layer - and the user
// receives a file that still shows the sensitive value while the UI reports
// success. That is precisely the kind of claim the audit chain exists to make
// trustworthy, so "we produced a file" and "we checked the file" are tracked as
// separate states.
//
// Runs inside the offscreen document: it needs DOM canvas access.

import type { Rect } from "../shared/types.js";

/**
 * A pixel counts as covered when its Rec.709 luminance is below this. Pure black
 * is 0; the threshold leaves room for encoder ringing on the box edges without
 * admitting partially-redacted text.
 */
export const REDACTION_DARK_LUMINANCE = 40;

/**
 * Fraction of a redaction box that must be dark for the box to count as applied.
 * A box that is only mostly covered still has legible edges.
 */
export const REDACTION_MIN_DARK_FRACTION = 0.85;

export type RedactionVerifyMethod = "pixel" | "page-pixels";

export interface RedactionVerification {
  /** True only when every checked region was confirmed covered. */
  verified: boolean;
  /**
   * How the check was performed, so the UI never implies more than was done.
   * - `pixel`: the encoded output was re-decoded and inspected.
   * - `page-pixels`: the page bitmaps that were flattened into the output were
   *   inspected. True for PDF output, where re-decoding the finished file would
   *   mean rendering it again.
   */
  method: RedactionVerifyMethod;
  checkedRegions: number;
  darkRegions: number;
  failures: string[];
}

export interface RegionCoverage {
  checked: number;
  dark: number;
  failures: string[];
}

/** Expands a rect by the padding the painter used, clipped to the canvas. */
function paddedBounds(rect: Rect, padding: number, width: number, height: number) {
  const x = Math.max(0, Math.floor(rect.x - padding));
  const y = Math.max(0, Math.floor(rect.y - padding));
  const right = Math.min(width, Math.ceil(rect.x + rect.width + padding));
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height + padding));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * Confirms that each rect really is covered in the supplied canvas.
 *
 * Only the boxed regions are read back, never the whole bitmap: a 24-megapixel
 * page is ~96MB of RGBA and reading all of it to check a few hundred boxes would
 * be both slow and a good way to get the tab killed.
 */
export function verifyCanvasRegions(
  canvas: HTMLCanvasElement,
  rects: Rect[],
  padding: number,
  label: string
): RegionCoverage {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { checked: 0, dark: 0, failures: [`${label}: canvas is unreadable`] };

  let checked = 0;
  let dark = 0;
  const failures: string[] = [];

  for (const rect of rects) {
    const box = paddedBounds(rect, padding, canvas.width, canvas.height);
    if (box.width === 0 || box.height === 0) {
      failures.push(`${label}: region at ${rect.x},${rect.y} falls outside the page`);
      continue;
    }
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(box.x, box.y, box.width, box.height).data;
    } catch (error) {
      failures.push(`${label}: could not read region at ${rect.x},${rect.y}`);
      continue;
    }
    let covered = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (luminance < REDACTION_DARK_LUMINANCE) covered += 1;
    }
    const fraction = pixels === 0 ? 0 : covered / pixels;
    checked += 1;
    if (fraction >= REDACTION_MIN_DARK_FRACTION) {
      dark += 1;
    } else {
      failures.push(
        `${label}: region at ${rect.x},${rect.y} is only ${(fraction * 100).toFixed(1)}% covered`
      );
    }
  }
  return { checked, dark, failures };
}

/**
 * Re-decodes the finished PNG and verifies it.
 *
 * This is the strongest check available: it inspects the exact bytes that will be
 * handed to the browser, so an encoder that dropped or rescaled the redaction
 * layer cannot pass.
 */
export async function verifyEncodedPng(
  outputBytes: Uint8Array,
  rects: Rect[],
  padding: number
): Promise<RedactionVerification> {
  const copy = new Uint8Array(outputBytes);
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(new Blob([copy], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return { verified: false, method: "pixel", checkedRegions: 0, darkRegions: 0, failures: ["canvas is unreadable"] };
    }
    ctx.drawImage(bitmap, 0, 0);
    const coverage = verifyCanvasRegions(canvas, rects, padding, "output");
    return {
      verified: coverage.failures.length === 0 && coverage.checked > 0,
      method: "pixel",
      checkedRegions: coverage.checked,
      darkRegions: coverage.dark,
      failures: coverage.failures
    };
  } catch (error) {
    return {
      verified: false,
      method: "pixel",
      checkedRegions: 0,
      darkRegions: 0,
      failures: [`output could not be re-decoded: ${error instanceof Error ? error.message : String(error)}`]
    };
  } finally {
    bitmap?.close();
  }
}

/** Verification result for output that was verified on its page bitmaps. */
export function pagePixelVerification(coverage: RegionCoverage): RedactionVerification {
  return {
    verified: coverage.failures.length === 0 && coverage.checked > 0,
    method: "page-pixels",
    checkedRegions: coverage.checked,
    darkRegions: coverage.dark,
    failures: coverage.failures
  };
}
