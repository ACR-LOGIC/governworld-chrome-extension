// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

/**
 * Lifting an image off a page so the Document Studio can OCR and redact it.
 *
 * A page scan reads `textContent`, so a page that *is* an image - a letterhead
 * scan, a rendered PDF, a screenshot - has nothing to scan. The bytes are still
 * there, and OCR already exists in the Document Studio; this module is the
 * bridge between the two.
 *
 * Two sources, in order of fidelity:
 *
 *   1. The original file. Best possible quality, and the only way to OCR a page
 *      scrolled past the viewport. Readable whenever the image's own bytes are
 *      reachable: a same-origin image, a `data:` URL, or any origin this
 *      extension already has permission for. It is deliberately *not* readable
 *      for arbitrary third-party hosts, because the extension ships with zero
 *      host permissions and asking for them is a product decision, not a fix.
 *
 *   2. A rendered capture of the tab. Works for any page the user has
 *      activated, but it photographs what is on screen, so the result is only
 *      as complete as the viewport and only as sharp as the current zoom.
 *
 * Everything stays on this device: the bytes go to the shared IndexedDB store
 * and are read by the existing document pipeline. Nothing is uploaded.
 */

import { storeFile, deleteFile } from "./documents.js";

/** The pipeline refuses documents over 20 MB; do not stage anything larger. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** A capture this large means the viewport was enormous or the page is hostile. */
const MAX_CAPTURE_BYTES = 24 * 1024 * 1024;

export type CaptureSource = "original" | "capture";

export interface CapturedImage {
  bytes: ArrayBuffer;
  mimeType: string;
  name: string;
  source: CaptureSource;
  /** True when the user should expect lower OCR quality than the original file. */
  degraded: boolean;
}

export class ImageCaptureError extends Error {
  constructor(
    message: string,
    readonly userMessage: string
  ) {
    super(message);
    this.name = "ImageCaptureError";
  }
}

const SUPPORTED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);

function mimeFromUrl(src: string): string {
  const path = src.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}

/** Derive a short, safe filename from an image URL. */
function nameFromUrl(src: string, mimeType: string): string {
  let base = "page-image";
  if (src.startsWith("data:")) return base + "." + (mimeType === "image/jpeg" ? "jpg" : "png");
  try {
    const path = new URL(src).pathname.split("/").filter(Boolean).pop();
    if (path) base = decodeURIComponent(path).slice(0, 80) || base;
  } catch {
    // Fall through to the default name.
  }
  // The pipeline sniffs the real type from the bytes; the extension is cosmetic.
  const ext = mimeType === "image/jpeg" ? "jpg" : "png";
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
}

/** Read a `data:` image URL into bytes. */
function decodeDataUrl(src: string): { bytes: ArrayBuffer; mimeType: string } | null {
  const match = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(src);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes: bytes.buffer, mimeType: match[1].toLowerCase() };
}

/**
 * Try the original file.
 *
 * A same-origin `fetch` is the clean case. For other origins the request is
 * still attempted, because the page may send CORS headers and because the
 * extension may already hold permission for that host - but a failure is
 * expected and is not an error, it just means the caller should fall back.
 */
export async function tryFetchOriginal(src: string): Promise<CapturedImage | null> {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }

  if (url.protocol === "data:") {
    const decoded = decodeDataUrl(src);
    if (!decoded) return null;
    if (decoded.bytes.byteLength > MAX_IMAGE_BYTES) throw new ImageCaptureError("image too large", "That image is too large to process on this device.");
    const mimeType = SUPPORTED_MIME.has(decoded.mimeType) ? decoded.mimeType : "image/png";
    return { bytes: decoded.bytes, mimeType, name: nameFromUrl(src, mimeType), source: "original", degraded: false };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  let response: Response;
  try {
    response = await fetch(url.href, { credentials: "omit", redirect: "follow" });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const declared = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  // Refuse anything that is not an image outright rather than handing a PDF or
  // an HTML error page to a pipeline that expects pixels.
  if (declared && !SUPPORTED_MIME.has(declared)) return null;

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) return null;
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new ImageCaptureError("image too large", "That image is too large to process on this device.");

  const mimeType = declared || mimeFromUrl(url.href);
  return { bytes: buffer, mimeType, name: nameFromUrl(url.href, mimeType), source: "original", degraded: false };
}

/**
 * Photograph the active tab.
 *
 * Requires activeTab, which the extension already declares and which the user
 * grants by invoking the extension on the tab. The result is the rendered
 * viewport, so it is a lossy stand-in: anything scrolled out of view is simply
 * not in it, and OCR accuracy follows the on-screen size of the document.
 */
export async function captureActiveTab(windowId: number): Promise<CapturedImage> {
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    throw new ImageCaptureError(
      `captureVisibleTab failed: ${error instanceof Error ? error.message : String(error)}`,
      "This page could not be captured. Open the image on its own page and try again."
    );
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new ImageCaptureError("capture returned no payload", "This page could not be captured.");
  const binary = atob(dataUrl.slice(comma + 1));
  if (binary.length === 0) throw new ImageCaptureError("capture was empty", "This page could not be captured.");
  if (binary.length > MAX_CAPTURE_BYTES) throw new ImageCaptureError("capture too large", "That image is too large to process on this device.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return {
    bytes: bytes.buffer,
    mimeType: "image/png",
    name: "page-capture.png",
    source: "capture",
    degraded: true,
  };
}

/** Prefer the original file; fall back to a rendered capture of the tab. */
export async function captureImage(src: string, windowId: number): Promise<CapturedImage> {
  const original = await tryFetchOriginal(src);
  if (original) return original;
  return captureActiveTab(windowId);
}

/**
 * Stage a captured image in the shared store, keyed like any other document.
 *
 * The popup previews it by sending the key back with POPUP_DOC_PREVIEW, which
 * reuses the entire existing document path - OCR, detection, review, redaction,
 * download and print - with no second redaction surface to maintain.
 */
export async function stageCapturedImage(image: CapturedImage, fileKey: string): Promise<void> {
  await storeFile(fileKey, image.bytes);
}
/** Drop a staged capture when preview never ran, so bytes are not left behind. */
export async function discardCapturedImage(fileKey: string): Promise<void> {
  await deleteFile(fileKey).catch(() => undefined);
}
