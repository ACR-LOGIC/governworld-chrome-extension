// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { DocKind, Finding, FindingCategory, Rect, RedactionOptions } from "../shared/types.js";
import type { CustomPattern } from "../shared/customPatterns.js";
import type { RedactionVerification } from "./verify.js";
import type { RedactedDocRef } from "../shared/docStore.js";

/**
 * Document redaction pipeline seam (spec step 6).
 *
 * The extension's in-page scanning pipeline (steps 1-5) is complete. The
 * document pipeline is a separate, browser-compatible port of the standalone
 * `packages/document-redaction` package (which is Node-only: it relies on
 * `sharp`). This interface defines the contract the popup can drive without
 * knowing the implementation. The concrete implementation
 * (`BrowserDocumentPipeline`) delegates to a dedicated offscreen document.
 */

export type DocumentKind = DocKind;

export interface DocumentInput {
  kind: DocumentKind;
  /** File bytes (the user's own selected local file). */
  bytes: ArrayBuffer;
  name: string;
  mimeType: string;
  /** Categories to detect; mirrors the extension's detection settings. */
  enabledCategories: FindingCategory[];
  /** Hard cap on pages processed per document. */
  maxPages: number;
  /**
   * Identifier used to derive the page-preview store keys. The offscreen
   * document persists the rendered page bitmaps under these keys instead of
   * returning them inline, because a base64 page image exceeds the runtime
   * message size limit.
   */
  previewKeyPrefix: string;
  /** Padding (px) added around applied redaction boxes. */
  padding: number;
  /** Preview pages already produced for this document (used for the redact summary). */
  previewPages: DocumentPage[];
  /** Detected categories present in the document (used for the redact summary). */
  categories: FindingCategory[];
  /** Optional redaction styling and stamps. */
  options?: RedactionOptions;
  /** Optional OCR language code. */
  ocrLanguage?: string;
  /** User-defined custom patterns from the Redaction Wizard. */
  customPatterns?: CustomPattern[];
}

export interface DocumentPage {
  index: number;
  widthPx: number;
  heightPx: number;
  findings: Finding[];
  /**
   * Key of the rendered page bitmap in the shared document store, not the image
   * itself. Page previews are hundreds of kilobytes of base64 and cannot travel
   * inside a runtime message, which is bounded by MAX_MESSAGE_BYTES.
   */
  previewKey: string;
  /**
   * Key of the same page at real resolution, for the full-screen review page.
   * Optional: a smaller thumbnail is a usable fallback, so a failure to stage
   * this one degrades the review surface instead of failing the preview.
   */
  pageImageKey?: string;
}

export interface RedactedDocumentResult {
  /** Flattened output bytes (PDF or image) with redaction baked in. */
  outputBytes: Uint8Array;
  outputMimeType: string;
  outputName: string;
  pages: DocumentPage[];
  /** Safe, metadata-only processing summary (never raw findings). */
  summary: { pages: number; redacted: number; categories: string[] };
  /**
   * Evidence that the redaction actually landed in the produced pixels. Callers
  * must not report success on the strength of `outputBytes` alone.
   */
  verification: RedactionVerification;
  /**
   * Store-backed handle to the redacted pages for the print/PDF view, or null
   * when staging failed. Absent is not an error: the flattened download is
   * already produced and verified; only the print affordance is missing.
   */
  printRef?: RedactedDocRef | null;
}

export interface DocumentPipeline {
  /**
   * Render pages + run local OCR/detectors, returning reviewable findings.
   * Must reject encrypted/malformed inputs without exposing their contents.
   */
  preview(input: DocumentInput): Promise<DocumentPage[]>;
  /**
   * Produce a flattened redacted copy using the provided boxes.
   * The original bytes are never mutated.
   */
  redact(
    input: DocumentInput,
    boxes: { pageIndex: number; rects: Rect[] }[],
    options?: RedactionOptions
  ): Promise<RedactedDocumentResult>;
}

export class UnavailableDocumentPipeline implements DocumentPipeline {
  async preview(): Promise<DocumentPage[]> {
    throw new Error("Document redaction is not available in this build yet.");
  }
  async redact(): Promise<RedactedDocumentResult> {
    throw new Error("Document redaction is not available in this build yet.");
  }
}