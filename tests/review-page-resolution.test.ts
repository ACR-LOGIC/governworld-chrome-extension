// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// The review surface must show the DOCUMENT, not an upscaled thumbnail.
//
// Two page images exist per page and they have different jobs:
//   previewKey    320x480, for the popup's ~360px thumbnail rail.
//   pageImageKey  real resolution, for the full-screen review page.
//
// The review page existed specifically because a page of text in a 360px column
// is unreadable, so serving it the thumbnail defeats the reason it exists: the
// user is asked to confirm that a box covers a value while looking at a blurry
// guess at where the value is. These tests pin that the review page asks for the
// real copy, that the key is validated like every other store key, and that the
// thumbnail still serves the popup.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateMessage } from "../src/shared/messages.js";
import { isPageImageKey, isPreviewKey, pageImageKey, PAGE_IMAGE_KEY_RE } from "../src/shared/docStore.js";

const extRoot = process.cwd();
const read = (p: string) => readFileSync(join(extRoot, p), "utf8");

const finding = {
  id: "doc:0:0",
  category: "ssn" as const,
  confidence: 0.93,
  source: "local-rules" as const,
  preview: "***-**-9999",
  nodeId: "doc:0",
  startOffset: 0,
  endOffset: 11,
  rects: [{ x: 10, y: 20, width: 100, height: 22 }],
  selected: true,
};

function docState(page: Record<string, unknown>) {
  return {
    type: "POPUP_DOC_STATE",
    requestId: "r1",
    docId: "d1",
    name: "letter.pdf",
    fileKey: "key1",
    mimeType: "application/pdf",
    kind: "pdf",
    pages: [{ index: 0, widthPx: 1275, heightPx: 1650, previewKey: "key1::preview::0", findings: [finding], ...page }],
  };
}

describe("page image keys are validated like every other store key", () => {
  it("derives and recognises them", () => {
    const key = pageImageKey("abc-123", 7);
    expect(key).toBe("abc-123::page::7");
    expect(isPageImageKey(key)).toBe(true);
    expect(PAGE_IMAGE_KEY_RE.test(key)).toBe(true);
  });

  it("cannot be confused with a thumbnail key or a path", () => {
    // The two key spaces must stay distinct: a page-image key must not satisfy
    // the preview matcher, or a caller could resolve a thumbnail where a
    // full-resolution image was meant.
    const page = pageImageKey("key1", 0);
    const thumb = pageImageKey("key1", 0).replace("::page::", "::preview::");
    expect(isPreviewKey(page)).toBe(false);
    expect(isPageImageKey(thumb)).toBe(false);
  });

  it("rejects traversal and non-store strings", () => {
    for (const bad of ["../../secrets", "http://evil.example/pg.png", "", "key1::page::x", "a".repeat(200)]) {
      expect(isPageImageKey(bad), bad).toBe(false);
    }
  });
});

describe("a page may carry a real-resolution image reference", () => {
  it("accepts a well-formed page image key", () => {
    expect(validateMessage(docState({ pageImageKey: pageImageKey("key1", 0) })).ok).toBe(true);
  });

  it("stays optional so a session staged by an older build still opens", () => {
    // `pageImageKey` was added after sessions started being persisted in
    // chrome.storage.session. Requiring it would make every restored session
    // unreadable, which is the "the document vanished" failure the session
    // descriptor exists to prevent.
    expect(validateMessage(docState({})).ok).toBe(true);
  });

  it("rejects a malformed one rather than passing it through", () => {
    for (const bad of ["../../secrets", "http://evil.example/pg.png", "key1::page::x", "key1::preview::0"]) {
      expect(validateMessage(docState({ pageImageKey: bad })).ok, bad).toBe(false);
    }
  });

  it("keeps a full 20-page document inside the message budget", () => {
    // 20 pages is MAX_DOC_PAGES. Two short keys per page still fit, which is only
    // true because the images are referenced rather than embedded.
    const pages = Array.from({ length: 20 }, (_, i) => ({
      index: i,
      widthPx: 1275,
      heightPx: 1650,
      previewKey: `key1::preview::${i}`,
      pageImageKey: `key1::page::${i}`,
      findings: Array.from({ length: 6 }, (_, f) => ({ ...finding, id: `doc:${i}:${f}` })),
    }));
    const message = { ...docState({}), pages };
    expect(JSON.stringify(message).length).toBeLessThanOrEqual(64 * 1024);
    expect(validateMessage(message).ok).toBe(true);
  });
});

describe("the review surface uses the real-resolution page, not the thumbnail", () => {
  const reviewSrc = read("src/popup/review.ts");

  it("asks for pageImageKey before falling back to the thumbnail", () => {
    expect(reviewSrc).toContain("page.pageImageKey");
    // Both must be present: a session without the newer key degrades to the
    // thumbnail instead of rendering nothing.
    expect(reviewSrc).toContain("page.previewKey");
    const use = reviewSrc.slice(reviewSrc.indexOf("page.pageImageKey") - 200);
    expect(use.indexOf("page.pageImageKey")).toBeLessThan(use.indexOf("page.previewKey"));
  });

  it("keeps the popup on the thumbnail", () => {
    // The popup rail must not pull a full-resolution PNG per page into a 360px
    // column; that is a memory cost for pixels nobody can see.
    const popupSrc = read("src/popup/popup.ts");
    const loader = popupSrc.slice(popupSrc.indexOf("function loadPreviewInto"));
    expect(loader.slice(0, 500)).toContain("page.previewKey");
    expect(loader.slice(0, 500)).not.toContain("pageImageKey");
  });

  it("bounds the stored page image instead of writing the canvas verbatim", () => {
    // Unbounded, a 24-megapixel scan would be written to IndexedDB per page.
    const implSrc = read("src/document-pipeline/impl.ts");
    expect(implSrc).toContain("PAGE_IMAGE_MAX_EDGE");
    const fn = implSrc.slice(implSrc.indexOf("async function canvasToPageImageBytes"));
    expect(fn.slice(0, 1200)).toContain("PAGE_IMAGE_MAX_EDGE");
  });

  it("never fails a preview because the review copy could not be made", () => {
    // The findings are already computed by this point; a missing review image
    // degrades one surface and must not discard the whole result.
    const implSrc = read("src/document-pipeline/impl.ts");
    const fn = implSrc.slice(implSrc.indexOf("async function canvasToPageImageBytes"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("return null");
    expect(body).toContain("catch");
  });

  it("keeps the review canvas at the page's real pixel size", () => {
    // The drawing surface is unchanged by any of this: a box is converted
    // through getBoundingClientRect, so it stays correct at any zoom.
    expect(reviewSrc).toMatch(/canvas\.width\s*=\s*page\.widthPx/);
    expect(reviewSrc).toMatch(/canvas\.height\s*=\s*page\.heightPx/);
  });
});