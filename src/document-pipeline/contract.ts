// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { DocKind, FindingCategory, Rect, RedactionOptions } from "../shared/types.js";
import type { CustomPattern } from "../shared/customPatterns.js";
import type { DocumentPage } from "./adapter.js";
import type { RedactionVerification } from "./verify.js";

/**
 * Contract between the service worker (orchestrator) and the offscreen
 * document (worker host with DOM + Worker access). The offscreen document is
 * where pdf.js/tesseract actually run; it is created on demand and owns zero
 * user-visible UI. All messages carry a `channel` marker so unrelated
 * extension contexts ignore them.
 */

import type { RedactedDocRef } from "../shared/docStore.js";

export const OFFSCREEN_CHANNEL = "doc-pipeline";

/** Hard cap on pages processed per document (mirrors impl defaults). */
export const MAX_DOC_PAGES = 20;

/**
 * Extension messaging serializes as JSON (Chrome < 148 and the default), so
 * binary payloads must be base64-encoded at the wire boundary. Service worker
 * and offscreen document both implement btoa/atob, so these are safe to call
 * from either side.
 */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export interface OffscreenPreviewRequest {
  channel: typeof OFFSCREEN_CHANNEL;
  op: "preview";
  jobId: string;
  kind: DocKind;
  /** Base64-encoded document bytes (extension messaging is JSON-serialized). */
  bytes: string;
  name: string;
  mimeType: string;
  enabledCategories: FindingCategory[];
  maxPages: number;
  ocrLanguage?: string;
  customPatterns?: CustomPattern[];
  /**
   * Identifier used to derive the page-preview store keys returned in
   * `pages[].previewKey`. Previews are written to the shared document store
   * rather than inlined, because a base64 page image exceeds the runtime message
   * size limit.
   */
  previewKeyPrefix: string;
}

export interface OffscreenRedactRequest {
  channel: typeof OFFSCREEN_CHANNEL;
  op: "redact";
  jobId: string;
  kind: DocKind;
  /** Base64-encoded document bytes (extension messaging is JSON-serialized). */
  bytes: string;
  name: string;
  mimeType: string;
  boxes: { pageIndex: number; rects: Rect[] }[];
  padding: number;
  options?: RedactionOptions;
  /**
   * Key used to namespace the staged redacted pages for the print view. Derived
   * from the document's own file key so a second redaction of the same file
   * replaces its print pages rather than accumulating stale ones.
   */
  fileKey?: string;
}

export type OffscreenRequest = OffscreenPreviewRequest | OffscreenRedactRequest;

export interface OffscreenPreviewResponse {
  channel: typeof OFFSCREEN_CHANNEL;
  op: "preview";
  jobId: string;
  ok: true;
  pages: DocumentPage[];
}

export interface OffscreenPreviewError {
  channel: typeof OFFSCREEN_CHANNEL;
  op: "preview";
  jobId: string;
  ok: false;
  code: string;
  userMessage: string;
}

export interface OffscreenRedactResponse {
  channel: typeof OFFSCREEN_CHANNEL;
  op: "redact";
  jobId: string;
  ok: true;
  /** Base64-encoded flattened output bytes (extension messaging is JSON-serialized). */
  outputBytes: string;
  outputMimeType: string;
  outputName: string;
  redactedCount: number;
  /** Evidence that the redaction actually landed in the produced pixels. */
  verification: RedactionVerification;
  /**
   * Store-backed handle for the print view. Carries geometry and store keys only
   * — no page content — so it stays well inside the runtime message limit.
   * Absent when staging failed, which is not an error: the download is still
   * correct, only the print affordance is unavailable.
   */
  printRef?: RedactedDocRef | null;
}

export interface OffscreenRedactError {
  channel: typeof OFFSCREEN_CHANNEL;
  op: "redact";
  jobId: string;
  ok: false;
  code: string;
  userMessage: string;
}

export type OffscreenResponse = OffscreenPreviewResponse | OffscreenPreviewError | OffscreenRedactResponse | OffscreenRedactError;

export function isOffscreenRequest(raw: unknown): raw is OffscreenRequest {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (r.channel !== OFFSCREEN_CHANNEL) return false;
  if (r.op !== "preview" && r.op !== "redact") return false;
  if (typeof r.jobId !== "string" || !r.jobId) return false;
  if (typeof r.kind !== "string" || (r.kind !== "pdf" && r.kind !== "image" && r.kind !== "docx")) return false;
  return true;
}

export function isOffscreenResponse(raw: unknown): raw is OffscreenResponse {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (r.channel !== OFFSCREEN_CHANNEL) return false;
  if (r.op !== "preview" && r.op !== "redact") return false;
  if (typeof r.jobId !== "string" || !r.jobId) return false;
  return true;
}