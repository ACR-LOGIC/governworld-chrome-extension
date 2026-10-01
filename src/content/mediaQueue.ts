// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

/**
 * Layers 2–5 — Media discovery and visual-capture queue building.
 *
 * After DOM text extraction (Layer 1) completes, this module walks the page and
 * queues every visual region that requires off-main-thread processing:
 *
 *   Layer 2: Raster images (<img>, CSS background-image)
 *   Layer 3: Canvas elements
 *   Layer 4: Video frames and subtitle/caption tracks
 *   Layer 5: Embedded PDFs (<embed>, <object>, <iframe src="*.pdf">,
 *             top-level application/pdf)
 *
 * Each queued item carries enough metadata for the service worker to decide how
 * to fetch/capture the pixels and send them to the offscreen OCR/PDF pipeline.
 * Pixel data is NEVER included in the queue items — only URLs, rects, and
 * pre-extractable data: URLs (e.g. untainted canvas.toDataURL() results). This
 * keeps every queue item well under MAX_MESSAGE_BYTES.
 *
 * The queue is sorted viewport-first and capped at maxVisualQueue per scan
 * pass. Any items beyond the cap are counted as "deferred" and reported in
 * the coverage status so the UI can offer a "Scan remaining N images" action.
 */

import {
  computeElementVisibility,
  buildTraceableSelector,
  type VisibilityState,
  type UnscannableRegion,
  type PageInventory,
} from "./normalization/pageInventory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Media source types that require visual capture or local PDF parsing. */
export type VisualCaptureSourceType =
  | "image-ocr"
  | "canvas-ocr"
  | "video-frame-ocr"
  | "pdf-text"
  | "pdf-ocr"
  | "screenshot-ocr";

/**
 * One item in the visual-capture queue. Sent from the content script to the
 * service worker as part of SCAN_RESULT stats. The SW dispatches each item
 * to captureImage.ts / offscreen.ts and posts results back asynchronously.
 *
 * SIZE CONTRACT: dataUrl must only be populated for data:image/... URLs that
 * are already present in the DOM (not newly captured). All other items carry
 * only a URL + cropRect so the message stays under MAX_MESSAGE_BYTES.
 */
export interface VisualCaptureRequest {
  /** Stable per-scan identifier. */
  sourceId: string;
  sourceType: VisualCaptureSourceType;
  /** CSS selector for provenance labelling in the review UI. */
  cssSelector: string;
  elementTag: string;
  /** Original resource URL (for fetch-first strategy). */
  resourceUrl?: string;
  /**
   * Pre-extracted data: URL when the pixel data is already locally accessible
   * (untainted canvas.toDataURL(), data:image/... src, or data: background).
   * When present the SW skips the fetch/capture step and forwards directly to
   * the offscreen OCR worker. Must start with "data:image/" when set.
   */
  dataUrl?: string;
  /** Viewport-relative bounding rect for captureVisibleTab crop fallback. */
  cropRect?: { x: number; y: number; width: number; height: number };
  visibility: VisibilityState;
}

export interface PdfExtractRequest {
  /** Resolved absolute URL of the PDF. */
  url: string;
  cssSelector: string;
  /** True for the top-level application/pdf viewer, false for embedded PDF. */
  isTopLevel: boolean;
}

export interface MediaQueueResult {
  /** Items for this scan pass (capped at maxVisualQueue). */
  visualQueue: VisualCaptureRequest[];
  pdfQueue: PdfExtractRequest[];
  /** Count of items beyond the per-pass cap (reported in coverage status). */
  deferredCount: number;
  /** Regions that cannot be inspected at all (e.g. DRM video already in inv). */
  newUnscannableRegions: UnscannableRegion[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum pixel area for an image to be considered text-bearing. */
const MIN_IMG_WIDTH = 24;
const MIN_IMG_HEIGHT = 14;
const MIN_CANVAS_WIDTH = 24;
const MIN_CANVAS_HEIGHT = 14;
const MIN_VIDEO_WIDTH = 40;
const MIN_VIDEO_HEIGHT = 30;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Discovers all visual media regions that need OCR or PDF parsing and
 * assembles two queues: one for visual captures (images / canvases / video
 * frames) and one for PDF URLs. Returns a result object containing both
 * queues, the deferred count, and any newly discovered unscannable regions.
 *
 * @param rootDoc        The document to walk (defaults to window.document).
 * @param inventory      The PageInventory already computed by Layer 0.
 * @param maxVisualQueue Per-scan cap on visual-capture items (default 8).
 * @param pageUrl        Base URL for resolving relative PDF src attributes.
 */
export function buildMediaQueue(
  rootDoc: Document = document,
  inventory: PageInventory,
  maxVisualQueue = 8,
  pageUrl = rootDoc.location?.href ?? ""
): MediaQueueResult {
  const allVisual: VisualCaptureRequest[] = [];
  const pdfQueue: PdfExtractRequest[] = [];
  const newUnscannableRegions: UnscannableRegion[] = [];
  const seenUrls = new Set<string>();
  let counter = 0;

  // ── Top-level PDF viewer (Layer 5, Plan C) ─────────────────────────────
  if (inventory.pdfs.isTopLevelPdfViewer && pageUrl) {
    pdfQueue.push({
      url: pageUrl,
      cssSelector: 'embed[type="application/x-google-chrome-pdf"]',
      isTopLevel: true,
    });
  }

  // ── Walk the DOM ───────────────────────────────────────────────────────
  const walker = rootDoc.createTreeWalker(rootDoc, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;

  while (node) {
    if (node instanceof Element) {
      const el = node;
      const tag = el.tagName.toLowerCase();
      const visibility = computeElementVisibility(el);
      const isVisible =
        visibility === "VISIBLE_IN_VIEWPORT" || visibility === "VISIBLE_OUT_OF_VIEWPORT";

      // Only queue media that is at least partially visible — hidden UI state
      // is already extracted (or deliberately excluded) by the DOM text layer.
      if (!isVisible) {
        node = walker.nextNode();
        continue;
      }

      const rect = el.getBoundingClientRect();
      const cropRect = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      const selector = buildTraceableSelector(el);

      // ── Layer 2: Raster images ──────────────────────────────────────
      if (tag === "img" && rect.width >= MIN_IMG_WIDTH && rect.height >= MIN_IMG_HEIGHT) {
        const img = el as HTMLImageElement;
        const src = img.currentSrc || img.src || "";
        if (src && !seenUrls.has(src)) {
          seenUrls.add(src);
          const item: VisualCaptureRequest = {
            sourceId: `img-${++counter}`,
            sourceType: "image-ocr",
            cssSelector: selector,
            elementTag: "img",
            resourceUrl: src,
            cropRect,
            visibility,
          };
          // data: URLs are already in memory — include them directly so the
          // SW can skip the fetch step and forward straight to OCR.
          if (/^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,/i.test(src)) {
            // Only include small data: URLs to stay within MAX_MESSAGE_BYTES.
            // Large ones will be fetched by the SW using the dataUrl as the src.
            if (src.length <= 32_768) {
              item.dataUrl = src;
            }
          }
          allVisual.push(item);
        }
      }

      // ── Layer 3: Canvas elements ────────────────────────────────────
      if (
        tag === "canvas" &&
        rect.width >= MIN_CANVAS_WIDTH &&
        rect.height >= MIN_CANVAS_HEIGHT
      ) {
        const canvas = el as HTMLCanvasElement;
        let dataUrl: string | undefined;
        try {
          const raw = canvas.toDataURL("image/png");
          // A blank / solid-colour canvas returns a tiny data URL — skip it.
          if (raw.length > 200) dataUrl = raw;
        } catch {
          // Tainted cross-origin canvas — will fall back to captureVisibleTab crop.
        }
        allVisual.push({
          sourceId: `canvas-${++counter}`,
          sourceType: "canvas-ocr",
          cssSelector: selector,
          elementTag: "canvas",
          dataUrl,
          cropRect,
          visibility,
        });
      }

      // ── Layer 4: Video frames ────────────────────────────────────────
      if (
        tag === "video" &&
        rect.width >= MIN_VIDEO_WIDTH &&
        rect.height >= MIN_VIDEO_HEIGHT
      ) {
        const video = el as HTMLVideoElement;
        // Skip DRM-protected videos (already marked unscannable in inventory).
        if (!video.mediaKeys && video.readyState >= 2) {
          let dataUrl: string | undefined;
          try {
            const tmp = rootDoc.createElement("canvas");
            tmp.width = Math.min(video.videoWidth || rect.width, 1280);
            tmp.height = Math.min(video.videoHeight || rect.height, 720);
            const ctx = tmp.getContext("2d");
            if (ctx) {
              ctx.drawImage(video, 0, 0, tmp.width, tmp.height);
              const raw = tmp.toDataURL("image/png");
              if (raw.length > 200) dataUrl = raw;
            }
          } catch {
            // Cross-origin video or SecurityError — SW will use captureVisibleTab crop.
          }
          allVisual.push({
            sourceId: `video-${++counter}`,
            sourceType: "video-frame-ocr",
            cssSelector: selector,
            elementTag: "video",
            resourceUrl: video.currentSrc || video.src || undefined,
            dataUrl,
            cropRect,
            visibility,
          });
        }
      }

      // ── Layer 5: Embedded PDFs ───────────────────────────────────────
      if (tag === "embed" || tag === "object" || tag === "iframe") {
        const type = (el.getAttribute("type") || "").toLowerCase();
        const rawSrc = el.getAttribute("src") || el.getAttribute("data") || "";
        if ((type.includes("pdf") || /\.pdf($|\?|#)/i.test(rawSrc)) && rawSrc) {
          try {
            const resolved = new URL(rawSrc, pageUrl).href;
            if (!seenUrls.has(resolved)) {
              seenUrls.add(resolved);
              pdfQueue.push({ url: resolved, cssSelector: selector, isTopLevel: false });
            }
          } catch {
            // Malformed URL — skip silently.
          }
        }
      }
    }
    node = walker.nextNode();
  }

  // ── Viewport-first sort + per-pass cap ─────────────────────────────────
  allVisual.sort((a, b) => {
    if (a.visibility === b.visibility) return 0;
    if (a.visibility === "VISIBLE_IN_VIEWPORT") return -1;
    return 1;
  });

  const deferredCount = Math.max(0, allVisual.length - maxVisualQueue);
  const visualQueue = allVisual.slice(0, maxVisualQueue);

  return { visualQueue, pdfQueue, deferredCount, newUnscannableRegions };
}

// ---------------------------------------------------------------------------
// Video caption extraction (Layer 4, deterministic path)
// ---------------------------------------------------------------------------

export interface VideoCaptionSegment {
  text: string;
  cssSelector: string;
  startTime: number;
  visibility: VisibilityState;
}

/**
 * Extracts all currently loaded WebVTT/SRT caption cues from every <video>
 * element in the document. Returns deterministic text (confidence 1.0) that
 * can be fed directly into detect.ts without OCR.
 */
export function extractVideoCaptions(rootDoc: Document = document): VideoCaptionSegment[] {
  const results: VideoCaptionSegment[] = [];
  const videos = rootDoc.querySelectorAll("video");

  for (const video of videos) {
    const visibility = computeElementVisibility(video);
    const selector = buildTraceableSelector(video);
    const { textTracks } = video;
    if (!textTracks) continue;

    for (let i = 0; i < textTracks.length; i++) {
      const track = textTracks[i];
      const cues = track.cues ?? track.activeCues;
      if (!cues) continue;
      for (let j = 0; j < cues.length; j++) {
        const cue = cues[j] as VTTCue;
        if (!cue || typeof cue.text !== "string") continue;
        const text = cue.text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        if (text) {
          results.push({ text, cssSelector: selector, startTime: cue.startTime, visibility });
        }
      }
    }
  }
  return results;
}
