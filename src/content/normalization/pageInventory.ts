// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

/**
 * Layer 0 — Page inventory discovery and honest coverage-status resolution.
 *
 * This module answers two questions:
 *   1. What content representations exist on this page (DOM text, images,
 *      canvases, videos, PDFs, shadow roots, iframes)?
 *   2. Given what we managed to inspect, what is the honest ScanCoverageStatus?
 *
 * It deliberately imports nothing from other content-script modules so it can
 * be used in unit tests without a DOM environment beyond what jsdom provides.
 *
 * chrome.dom.openOrClosedShadowRoot is declared with a weak ambient type so
 * the module compiles in both the extension context (where it exists) and in
 * unit tests (where it does not).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VisibilityState =
  | "VISIBLE_IN_VIEWPORT"
  | "VISIBLE_OUT_OF_VIEWPORT"
  | "HIDDEN_COLLAPSED_UI" // closed modal, inactive tab, display:none, etc.
  | "HIDDEN_METADATA" // alt/title/aria attribute — never rendered as text
  | "UNVERIFIED_VISIBILITY";

export type ScanCoverageStatus =
  | "FULLY_SCANNED"
  | "PARTIALLY_SCANNED"
  | "UNSUPPORTED_CONTENT_PRESENT"
  | "BLOCKED_BY_BROWSER_SECURITY"
  | "NO_SENSITIVE_DATA_DETECTED"
  | "SCAN_FAILED";

export type UnscannableReason =
  | "cross-origin-isolation"
  | "tainted-canvas-no-tab-capture"
  | "drm-protected-media"
  | "chrome-internal-page"
  | "file-url-permission-disabled"
  | "pdf-viewer-plugin-isolated"
  | "blob-revoked-or-inaccessible"
  | "ocr-budget-exceeded"
  | "scan-error";

export interface UnscannableRegion {
  sourceType: string;
  cssSelector: string;
  resourceUrl?: string;
  visibility: VisibilityState;
  reason: UnscannableReason;
  detail: string;
  boundingRect?: { x: number; y: number; width: number; height: number };
}

export interface PageInventory {
  domTextRegions: number;
  formControls: number;
  openShadowRoots: number;
  closedShadowRootsAccessed: number;
  sameOriginIframes: number;
  crossOriginIframes: number;
  images: {
    total: number;
    visible: number;
    dataOrBlob: number;
    cssBackgrounds: number;
    inlineSvgs: number;
  };
  canvases: number;
  videos: { total: number; withTracks: number; visible: number };
  audios: number;
  pdfs: { embedded: number; isTopLevelPdfViewer: boolean };
  unscannableRegions: UnscannableRegion[];
}

// ---------------------------------------------------------------------------
// chrome.dom ambient declaration (extension-only API)
// ---------------------------------------------------------------------------

declare global {
  interface Chrome {
    dom?: {
      openOrClosedShadowRoot?: (element: Element) => ShadowRoot | null;
    };
  }
}

// ---------------------------------------------------------------------------
// Shadow DOM access
// ---------------------------------------------------------------------------

/**
 * Returns the shadow root for an element, accessing closed shadow roots via
 * the Chromium extension API chrome.dom.openOrClosedShadowRoot when available.
 * Falls back to element.shadowRoot (open roots only) in other environments.
 */
export function getAccessibleShadowRoot(element: Element): ShadowRoot | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromeApi = (globalThis as any).chrome as Chrome | undefined;
    if (chromeApi?.dom?.openOrClosedShadowRoot) {
      const root = chromeApi.dom.openOrClosedShadowRoot(element);
      if (root) return root;
    }
  } catch {
    // Outside Chromium content script context (e.g. unit tests) — fall through.
  }
  return element.shadowRoot ?? null;
}

// ---------------------------------------------------------------------------
// Visibility classification
// ---------------------------------------------------------------------------

/**
 * Classifies an element's visibility without mutating the DOM.
 * Used to distinguish visible findings from hidden/metadata findings so
 * the UI never conflates "in DOM but offscreen or collapsed" with "on screen".
 */
export function computeElementVisibility(el: Element): VisibilityState {
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) {
    return "UNVERIFIED_VISIBILITY";
  }
  // Structural ancestors that always hide content
  if (el.closest("[hidden], [inert], template, script, style, noscript")) {
    return "HIDDEN_COLLAPSED_UI";
  }
  if (el.closest("[aria-hidden='true']")) {
    return "HIDDEN_COLLAPSED_UI";
  }
  // Computed style visibility
  try {
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      parseFloat(style.opacity) === 0
    ) {
      return "HIDDEN_COLLAPSED_UI";
    }
    // Modern browsers — prefer this over manual rect checks
    if (typeof (el as HTMLElement).checkVisibility === "function") {
      if (!(el as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return "HIDDEN_COLLAPSED_UI";
      }
    }
  } catch {
    // Detached node or non-browser env — default to unverified.
    return "UNVERIFIED_VISIBILITY";
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return "HIDDEN_COLLAPSED_UI";
  }
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  return inViewport ? "VISIBLE_IN_VIEWPORT" : "VISIBLE_OUT_OF_VIEWPORT";
}

// ---------------------------------------------------------------------------
// Traceable CSS selector
// ---------------------------------------------------------------------------

/**
 * Builds a short, human-readable CSS selector for provenance reporting.
 * Prefers id anchors (stops immediately), falls back to tag+class+nth-of-type.
 * Caps depth at 5 levels to keep selectors readable in the review UI.
 */
export function buildTraceableSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  let depth = 0;

  while (current && depth < 5 && current !== document.documentElement) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      // ID is globally unique — stop here.
      try {
        part += `#${CSS.escape(current.id)}`;
      } catch {
        part += `[id="${current.id.replace(/"/g, '\\"')}"]`;
      }
      parts.unshift(part);
      break;
    }
    const nameAttr = current.getAttribute("name");
    if (nameAttr) {
      try {
        part += `[name="${CSS.escape(nameAttr)}"]`;
      } catch {
        /* ignore */
      }
    } else if (current.classList.length > 0) {
      const cls = Array.from(current.classList)
        .slice(0, 2)
        .map((c) => {
          try { return `.${CSS.escape(c)}`; } catch { return ""; }
        })
        .join("");
      part += cls;
    }
    const parent: Element | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c: Element) => c.tagName === current!.tagName
      );
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }
    parts.unshift(part);
    const rootNode = current.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      parts.unshift(`::shadow-root(${rootNode.mode})`);
      current = rootNode.host;
    } else {
      current = parent;
    }
    depth++;
  }
  return parts.join(" > ") || el.tagName.toLowerCase();
}

// ---------------------------------------------------------------------------
// Page inventory discovery (Layer 0)
// ---------------------------------------------------------------------------

/**
 * Walks the document and all accessible shadow roots / same-origin iframes,
 * cataloguing every content representation. Returns a live-count inventory
 * plus any regions that cannot be inspected by the extension.
 *
 * This function is purely additive — it never writes to the DOM.
 */
export function discoverPageInventory(rootDoc: Document = document): PageInventory {
  const inv: PageInventory = {
    domTextRegions: 0,
    formControls: 0,
    openShadowRoots: 0,
    closedShadowRootsAccessed: 0,
    sameOriginIframes: 0,
    crossOriginIframes: 0,
    images: { total: 0, visible: 0, dataOrBlob: 0, cssBackgrounds: 0, inlineSvgs: 0 },
    canvases: 0,
    videos: { total: 0, withTracks: 0, visible: 0 },
    audios: 0,
    pdfs: {
      embedded: 0,
      isTopLevelPdfViewer:
        rootDoc.contentType === "application/pdf" ||
        Boolean(rootDoc.querySelector('embed[type="application/x-google-chrome-pdf"]')),
    },
    unscannableRegions: [],
  };

  // Chrome's built-in PDF viewer is always unscannable via DOM — record it once.
  if (inv.pdfs.isTopLevelPdfViewer) {
    inv.unscannableRegions.push({
      sourceType: "pdf-text",
      cssSelector: 'embed[type="application/x-google-chrome-pdf"]',
      resourceUrl: rootDoc.location?.href,
      visibility: "VISIBLE_IN_VIEWPORT",
      reason: "pdf-viewer-plugin-isolated",
      detail:
        "Chrome built-in PDF viewer isolates its plugin DOM. The extension will attempt to fetch the PDF bytes locally and parse them via pdf.ts instead.",
    });
  }

  const visitedIframes = new WeakSet<HTMLIFrameElement>();

  const walkRoot = (root: Document | ShadowRoot, depth = 0): void => {
    // Prevent infinite recursion via circular shadow root references
    if (depth > 10) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;

    while (node) {
      if (node instanceof Element) {
        const el = node;
        const tag = el.tagName.toLowerCase();
        const visibility = computeElementVisibility(el);
        const rect = el.getBoundingClientRect();
        const boundingRect = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };

        // ── Shadow DOM ────────────────────────────────────────────
        const shadow = getAccessibleShadowRoot(el);
        if (shadow) {
          if (shadow.mode === "open") inv.openShadowRoots++;
          else inv.closedShadowRootsAccessed++;
          walkRoot(shadow, depth + 1);
        }

        // ── Form Controls ─────────────────────────────────────────
        if (tag === "input" || tag === "textarea" || tag === "select") {
          inv.formControls++;
        }

        // ── Images ───────────────────────────────────────────────
        if (tag === "img") {
          const img = el as HTMLImageElement;
          if (rect.width >= 24 && rect.height >= 14) {
            inv.images.total++;
            if (visibility === "VISIBLE_IN_VIEWPORT" || visibility === "VISIBLE_OUT_OF_VIEWPORT") {
              inv.images.visible++;
            }
            const src = img.currentSrc || img.src || "";
            if (src.startsWith("data:") || src.startsWith("blob:")) {
              inv.images.dataOrBlob++;
            }
          }
        } else if (tag !== "svg") {
          // CSS background-image (skip SVG elements — counted separately)
          try {
            const bg = window.getComputedStyle(el).backgroundImage;
            if (bg && bg.includes("url(") && rect.width >= 60 && rect.height >= 30) {
              inv.images.cssBackgrounds++;
            }
          } catch {
            /* detached node */
          }
        }

        // ── Inline SVGs ──────────────────────────────────────────
        if (tag === "svg" && rect.width >= 24 && rect.height >= 14) {
          inv.images.inlineSvgs++;
        }

        // ── Canvas ───────────────────────────────────────────────
        if (tag === "canvas" && rect.width >= 24 && rect.height >= 14) {
          inv.canvases++;
        }

        // ── Video ────────────────────────────────────────────────
        if (tag === "video") {
          const video = el as HTMLVideoElement;
          inv.videos.total++;
          if (video.textTracks && video.textTracks.length > 0) inv.videos.withTracks++;
          if (visibility === "VISIBLE_IN_VIEWPORT" || visibility === "VISIBLE_OUT_OF_VIEWPORT") {
            inv.videos.visible++;
          }
          // DRM-encrypted video: frames are hardware-zeroed on capture
          if (video.mediaKeys) {
            inv.unscannableRegions.push({
              sourceType: "video-frame-ocr",
              cssSelector: buildTraceableSelector(video),
              resourceUrl: video.currentSrc || video.src,
              visibility,
              reason: "drm-protected-media",
              detail: "EME/DRM encrypted video frames are hardware-zeroed by the OS on capture.",
              boundingRect,
            });
          }
        }

        // ── Audio ────────────────────────────────────────────────
        if (tag === "audio") {
          inv.audios++;
        }

        // ── Embedded PDFs ────────────────────────────────────────
        if (tag === "embed" || tag === "object") {
          const type = (el.getAttribute("type") || "").toLowerCase();
          const dataUrl = el.getAttribute("src") || el.getAttribute("data") || "";
          if (type.includes("pdf") || /\.pdf($|\?|#)/i.test(dataUrl)) {
            inv.pdfs.embedded++;
          }
        }

        // ── Iframes ──────────────────────────────────────────────
        if (tag === "iframe" || tag === "frame") {
          const frame = el as HTMLIFrameElement;
          if (!visitedIframes.has(frame)) {
            visitedIframes.add(frame);
            try {
              const frameDoc = frame.contentDocument;
              if (frameDoc) {
                inv.sameOriginIframes++;
                // Recursively walk same-origin frames (already handled by
                // traverseIframes in content.ts — we just count them here).
              } else {
                inv.crossOriginIframes++;
                inv.unscannableRegions.push({
                  sourceType: "iframe",
                  cssSelector: buildTraceableSelector(frame),
                  resourceUrl: frame.src,
                  visibility,
                  reason: "cross-origin-isolation",
                  detail:
                    "Cross-origin iframe DOM is inaccessible from the parent content script. " +
                    "If within the visible viewport, a captureVisibleTab crop + OCR will be attempted.",
                  boundingRect,
                });
              }
            } catch {
              inv.crossOriginIframes++;
              inv.unscannableRegions.push({
                sourceType: "iframe",
                cssSelector: buildTraceableSelector(frame),
                resourceUrl: frame.src,
                visibility,
                reason: "cross-origin-isolation",
                detail: "SecurityError reading iframe.contentDocument — cross-origin frame.",
                boundingRect,
              });
            }
          }
        }
      }
      node = walker.nextNode();
    }
  };

  walkRoot(rootDoc);
  return inv;
}

// ---------------------------------------------------------------------------
// Coverage status resolution
// ---------------------------------------------------------------------------

/**
 * Computes the honest ScanCoverageStatus from the post-scan state.
 *
 * INVARIANT: "NO_SENSITIVE_DATA_DETECTED" is only returned when EVERY
 * discovered content source was successfully inspected (deferredMediaCount===0
 * and no unresolved unscannableRegions). Any state that conflates "we couldn't
 * inspect it" with "it's clean" violates the fail-closed principle.
 */
export function resolveScanCoverageStatus(params: {
  findingsCount: number;
  unresolvedRegions: UnscannableRegion[];
  deferredMediaCount: number;
  hadRuntimeError?: boolean;
}): ScanCoverageStatus {
  const { findingsCount, unresolvedRegions, deferredMediaCount, hadRuntimeError } = params;

  if (hadRuntimeError) return "SCAN_FAILED";

  if (unresolvedRegions.some((r) => r.reason === "drm-protected-media")) {
    return "UNSUPPORTED_CONTENT_PRESENT";
  }

  const blockedReasons: UnscannableReason[] = [
    "cross-origin-isolation",
    "chrome-internal-page",
    "file-url-permission-disabled",
    "pdf-viewer-plugin-isolated",
    "tainted-canvas-no-tab-capture",
  ];
  if (unresolvedRegions.some((r) => blockedReasons.includes(r.reason))) {
    return "BLOCKED_BY_BROWSER_SECURITY";
  }

  if (deferredMediaCount > 0 || unresolvedRegions.length > 0) {
    return "PARTIALLY_SCANNED";
  }

  if (findingsCount === 0) return "NO_SENSITIVE_DATA_DETECTED";
  return "FULLY_SCANNED";
}
