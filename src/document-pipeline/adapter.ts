// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { DocKind, Finding, FindingCategory, Rect } from "../shared/types.js";
import type { RedactionVerification } from "./verify.js";

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
  /** Padding (px) added around applied redaction boxes. */
  padding: number;
  /** Preview pages already produced for this document (used for the redact summary). */
  previewPages: DocumentPage[];
  /** Detected categories present in the document (used for the redact summary). */
  categories: FindingCategory[];
}

export interface DocumentPage {
  index: number;
  widthPx: number;
  heightPx: number;
  findings: Finding[];
  /** Rendered page bitmap for the review UI. */
  previewDataUrl: string;
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
  redact(input: DocumentInput, boxes: { pageIndex: number; rects: Rect[] }[]): Promise<RedactedDocumentResult>;
}

export class UnavailableDocumentPipeline implements DocumentPipeline {
  async preview(): Promise<DocumentPage[]> {
    throw new Error("Document redaction is not available in this build yet.");
  }
  async redact(): Promise<RedactedDocumentResult> {
    throw new Error("Document redaction is not available in this build yet.");
  }
}