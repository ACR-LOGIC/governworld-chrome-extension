// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// The review page exists so a person can read the words before deciding whether
// a box covers them. A fixed 800px sheet defeats that on a large monitor and
// overflows on a small one, so the sheet follows the stage (Fit) with explicit
// steps up to 3x native for fine judgement.
//
// These are source-level assertions, matching tests/document-studio-feedback.test.ts:
// zoom correctness needs a real window and a real pipeline, neither of which runs
// in CI, so the contract is pinned statically instead of left untested.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const extRoot = process.cwd();
const reviewSrc = readFileSync(join(extRoot, "src/popup/review.ts"), "utf8");
const reviewHtml = readFileSync(join(extRoot, "src/popup/review.html"), "utf8");
const reviewCss = readFileSync(join(extRoot, "src/popup/review.css"), "utf8");

describe("the review page can be read at a usable size", () => {
  it("fits the sheet to the stage instead of pinning a pixel width", () => {
    // The old rule was a hard `width: 800px`, which is a blurry upscale on a
    // laptop and wasted space on a 4K display. Fit is the default for that.
    expect(reviewCss).not.toMatch(/\.review__sheet\s*\{[^}]*width:\s*800px/);
    // Scanned to the end of the rule, so a long comment above the declaration
    // cannot make the assertion pass on the comment's own words.
    const sheet = reviewCss.slice(reviewCss.indexOf(".review__sheet {"));
    expect(sheet.slice(0, sheet.indexOf("}"))).toMatch(/width:\s*100%/);
  });

  it("offers zoom controls with an accessible label for the current scale", () => {
    for (const id of ["zoom-in", "zoom-out", "zoom-fit", "zoom-label"]) {
      expect(reviewHtml, `review.html is missing #${id}`).toContain(`id="${id}"`);
      expect(reviewSrc, `review.ts never wires #${id}`).toContain(`"${id}"`);
    }
    // The +/- buttons need names, or a screen reader announces only "button".
    expect(reviewHtml).toMatch(/id="zoom-in"[^>]*aria-label=/);
    expect(reviewHtml).toMatch(/id="zoom-out"[^>]*aria-label=/);
    // The scale is announced, so a change is not purely visual.
    expect(reviewHtml).toMatch(/id="zoom-label"[^>]*aria-live="polite"/);
  });

  it("bounds zoom at both ends", () => {
    expect(reviewSrc).toContain("MIN_ZOOM");
    expect(reviewSrc).toContain("MAX_ZOOM");
    // Unbounded zoom would let a page be blown up to a size no document has.
    expect(reviewSrc).toMatch(/zoom:\s*3\b|\b3\b/);
  });

  it("zooms without touching the canvas backing store", () => {
    // The box is converted through getBoundingClientRect, so the canvas must stay
    // at the page's real pixel size. Resizing the backing store with the zoom
    // would silently change the coordinate space the worker's rects live in.
    expect(reviewSrc).toMatch(/canvas\.width\s*=\s*page\.widthPx/);
    expect(reviewSrc).toMatch(/canvas\.height\s*=\s*page\.heightPx/);
    const apply = reviewSrc.slice(reviewSrc.indexOf("function applyZoom"));
    const body = apply.slice(0, apply.indexOf("\n}"));
    expect(body).not.toMatch(/canvas\.(width|height)\s*=/);
  });

  it("supports the keyboard shortcut a reader would reach for", () => {
    // Ctrl/Cmd +/- and 0, and preventDefault so the browser does not zoom the
    // whole window instead of the document.
    expect(reviewSrc).toContain('e.key === "+"');
    expect(reviewSrc).toContain('e.key === "-"');
    expect(reviewSrc).toContain('e.key === "0"');
    expect(reviewSrc).toContain("e.preventDefault()");
  });

  it("does not leave the zoom controls dangling when there is no document", () => {
    // applyZoom() early-returns without a session; the buttons must not throw.
    const apply = reviewSrc.slice(reviewSrc.indexOf("function applyZoom"));
    expect(apply.slice(0, 200)).toContain("if (!dom.pages || !session) return;");
  });
});