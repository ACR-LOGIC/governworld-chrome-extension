// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

/**
 * Layer 2 (SVG branch) — Extract visible text from inline SVG elements.
 *
 * Inline SVGs can contain readable text via <text>, <tspan>, <title>, and
 * <desc> elements. Standard DOM text walkers that exclude the "SVG" tag miss
 * all of this. This module walks those nodes specifically and returns text
 * segments with "svg" provenance so the review UI can label them correctly.
 *
 * External <img src="*.svg"> files are raster-captured for OCR instead (their
 * DOM is not accessible from the parent page's content script).
 */

import { computeElementVisibility, buildTraceableSelector } from "./normalization/pageInventory.js";

export interface SvgTextSegment {
  text: string;
  cssSelector: string;
  elementTag: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  visibility: import("./normalization/pageInventory.js").VisibilityState;
}

const SVG_TEXT_TAGS = new Set(["text", "tspan", "title", "desc"]);

/**
 * Extracts text from all inline <svg> elements in the document.
 * Returns segments with their on-page bounding rectangles for overlay
 * matching. Empty/whitespace-only strings are omitted.
 */
export function extractSvgText(rootDoc: Document = document): SvgTextSegment[] {
  const results: SvgTextSegment[] = [];
  const seenKeys = new Set<string>();

  const svgs = rootDoc.querySelectorAll("svg");
  for (const svg of svgs) {
    // Skip decorative SVGs that are too small to hold legible text
    const svgRect = svg.getBoundingClientRect();
    if (svgRect.width < 24 || svgRect.height < 14) continue;

    const walker = rootDoc.createTreeWalker(svg, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.currentNode;

    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.nodeValue ?? "").replace(/\s+/g, " ").trim();
        if (text.length === 0) {
          node = walker.nextNode();
          continue;
        }
        const parent = node.parentElement;
        if (!parent) {
          node = walker.nextNode();
          continue;
        }
        const tag = parent.tagName.toLowerCase();
        if (!SVG_TEXT_TAGS.has(tag)) {
          node = walker.nextNode();
          continue;
        }
        const selector = buildTraceableSelector(parent);
        const dedupKey = `${selector}::${text}`;
        if (seenKeys.has(dedupKey)) {
          node = walker.nextNode();
          continue;
        }
        seenKeys.add(dedupKey);
        const rect = parent.getBoundingClientRect();
        results.push({
          text,
          cssSelector: selector,
          elementTag: tag,
          boundingRect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          visibility: computeElementVisibility(parent),
        });
      }
      node = walker.nextNode();
    }
  }
  return results;
}
