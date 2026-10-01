// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { RedactionVerifyMethod } from "../document-pipeline/verify.js";
/**
 * Shared data model for the redaction extension.
 * These types cross every trust boundary (popup <-> service worker <-> content
 * script) and must stay plain JSON-serializable. Never attach DOM nodes or
 * runtime-only handles here.
 */

import type { CustomPattern, CommunityAccount, CommunityRule } from "./customPatterns";
import type { PatternTestResult, WizardAnalysis } from "./wizardAnalyzer";
import type { ImageCandidate } from "./messages";

export type FindingCategory =
  | "email"
  | "phone"
  | "ssn"
  | "dob"
  | "medical_record_number"
  | "member_id"
  | "npi"
  | "dea"
  | "mbi"
  | "address"
  | "payment_card"
  | "secrets"
  | "possible_name"
  | "custom"
  | "canadian_sin"
  | "uk_nhs"
  | "aadhaar"
  | "pan_india"
  | "australian_tfn"
  | "cpf";

export type FindingSource = "local-rules" | "local-model" | "gateway" | "attr" | "custom-pattern";

/** Document kinds the offscreen pipeline can process. */
export type DocKind = "pdf" | "image" | "docx";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Finding {
  id: string;
  category: FindingCategory;
  confidence: number; // 0..1
  source: FindingSource;
  /** Always masked, e.g. "j***@example.com". Never the raw value. */
  preview: string;
  /** Node id assigned by the content script's extraction pass. */
  nodeId: string;
  /** Character offsets into the combined scan text. */
  startOffset: number;
  endOffset: number;
  /** One or more page rectangles covered by this finding. */
  rects: Rect[];
  /** Minimized surrounding context, always masked. */
  contextPreview?: string;
  /**
   * Accessibility attribute this finding was found in (source === "attr").
   * The exact attribute name, e.g. "aria-label". Report-only findings are
   * never selectable for masking and never mutate the DOM.
   */
  attribute?: string;
  selected: boolean;
}

export type RedactionStyle = "blackout" | "whiteout" | "stamp";

export interface RedactionOptions {
  style?: RedactionStyle;
  stampText?: string;
  padding?: number;
  fillColor?: string;
}

export type ScanMode = "local" | "cloud";

/**
 * Media provenance for a single visual-capture queue item sent from the content
 * script to the service worker. The service worker dispatches each item to the
 * offscreen OCR / PDF pipeline asynchronously after a DOM scan. No pixel data
 * is included — only URLs, pre-extracted data: URLs (small only), and rects.
 */
export interface VisualCaptureRequestItem {
  sourceId: string;
  sourceType: "image-ocr" | "canvas-ocr" | "video-frame-ocr" | "pdf-text" | "pdf-ocr" | "screenshot-ocr";
  cssSelector: string;
  elementTag: string;
  resourceUrl?: string;
  /**
   * Pre-extracted data: URL for untainted canvases and small inline data: images.
   * Must start with "data:image/" when set. Omitted for large images and cross-
   * origin assets so the message stays under MAX_MESSAGE_BYTES.
   */
  dataUrl?: string;
  cropRect?: { x: number; y: number; width: number; height: number };
  visibility: "VISIBLE_IN_VIEWPORT" | "VISIBLE_OUT_OF_VIEWPORT" | "HIDDEN_COLLAPSED_UI" | "HIDDEN_METADATA" | "UNVERIFIED_VISIBILITY";
}

/** A PDF resource that needs local parsing by the offscreen document-pipeline. */
export interface PdfExtractRequestItem {
  url: string;
  cssSelector: string;
  isTopLevel: boolean;
}

/**
 * Honest coverage classification for the scan session. Reported in scan stats
 * so the popup can display the correct status badge.
 *
 * INVARIANT: "NO_SENSITIVE_DATA_DETECTED" is only emitted when every discovered
 * content region was successfully inspected (deferredMediaCount===0 and no
 * unscannable regions). Any other outcome that conflates "couldn't inspect" with
 * "nothing found" violates the fail-closed architecture.
 */
export type ScanCoverageStatus =
  | "FULLY_SCANNED"
  | "PARTIALLY_SCANNED"
  | "UNSUPPORTED_CONTENT_PRESENT"
  | "BLOCKED_BY_BROWSER_SECURITY"
  | "NO_SENSITIVE_DATA_DETECTED"
  | "SCAN_FAILED";

export interface ScanStats {
  visibleChars: number;
  /** Characters of accessibility-attribute text also analyzed. */
  attrChars?: number;
  truncated: boolean;
  startedAt?: number;
  finishedAt?: number;
  /**
   * Visual media regions queued for async OCR / PDF extraction.
   * The service worker processes these after the DOM scan completes and merges
   * the resulting findings into a follow-up POPUP_STATE update.
   */
  visualQueue?: VisualCaptureRequestItem[];
  /** PDF URLs (embedded or top-level viewer) queued for local extraction. */
  pdfQueue?: PdfExtractRequestItem[];
  /**
   * Number of visual regions beyond the per-pass budget cap that were deferred.
   * When > 0 the popup shows a "Scan N more images" offer.
   */
  deferredMediaCount?: number;
  /** Honest coverage classification based on what was and was not inspected. */
  coverageStatus?: ScanCoverageStatus;
}


/**
 * Typed message contract between extension contexts. Discriminated unions only;
 * every message is validated at runtime on arrival.
 */

export type PopupMessage =
  | { type: "POPUP_SCAN"; requestId: string; mode: ScanMode }
  | { type: "POPUP_APPLY_MASKS"; requestId: string; findingIds: string[] }
  | { type: "POPUP_REMOVE_MASKS"; requestId: string }
  | { type: "POPUP_COPY_REDACTED"; requestId: string; findingIds: string[] }
  | { type: "POPUP_CLEAR_DATA"; requestId: string }
  | { type: "POPUP_GET_STATE"; requestId: string }
  | { type: "POPUP_SET_MODE"; requestId: string; mode: ScanMode }
  | { type: "POPUP_DOC_PREVIEW"; requestId: string; fileKey: string; name: string; mimeType: string; kind: DocKind }
  | { type: "POPUP_DOC_REDACT"; requestId: string; docId: string; fileKey: string; name: string; mimeType: string; kind: DocKind; boxes: { pageIndex: number; rects: Rect[] }[]; findingIds: string[]; options?: RedactionOptions }
  | { type: "POPUP_DOC_CLEAR"; requestId: string; docId: string }
  /**
   * Lift an image off the active page into the Document Studio. Used when a page
   * scan finds no text to read, which is what an image-only page looks like.
   */
  | { type: "POPUP_DOC_CAPTURE_IMAGE"; requestId: string; src: string; name: string }
  | { type: "POPUP_DOC_CANCEL"; requestId: string; docId: string }
  /**
   * Opens the read-only print/PDF view for an already-redacted document. The
   * fileKey names a manifest in the shared store; the page loads the page
   * bitmaps itself, so no image crosses the message boundary.
   */
  | { type: "POPUP_DOC_PRINT"; requestId: string; fileKey: string }
  | {
      /**
       * The popup's actual delivery outcome for an artifact the worker could not
       * hand to the browser itself.
       *
       * The audit chain must record what happened to the user's file, not what
       * happened inside the worker. When the worker's own `chrome.downloads` call
       * fails and the popup takes over, only the popup knows whether the file
       * actually arrived - so the worker defers the audit record until this
       * arrives, and records "error" if it never does.
       */
      type: "POPUP_DOC_DELIVERY_REPORT";
      requestId: string;
      delivered: boolean;
    }
  | { type: "POPUP_EXPORT_AUDIT"; requestId: string }
  | { type: "POPUP_UNDO_MASKS"; requestId: string }
  | { type: "POPUP_SET_NOTIFICATIONS"; requestId: string; enabled: boolean }
  | { type: "POPUP_ACCOUNT_SAVE"; requestId: string; gatewayOrigin: string; apiKey: string }
  | { type: "POPUP_ACCOUNT_CLEAR"; requestId: string }
  | { type: "POPUP_ACCOUNT_PURCHASE"; requestId: string; planId: string }
  | { type: "POPUP_WIZARD_ANALYZE"; requestId: string; positiveExamples: string[]; negativeExamples: string[] }
  | { type: "POPUP_WIZARD_TEST"; requestId: string; regex: string; sampleText: string }
  | { type: "POPUP_CUSTOM_PATTERNS_GET"; requestId: string }
  | { type: "POPUP_CUSTOM_PATTERN_SAVE"; requestId: string; pattern: CustomPattern }
  | { type: "POPUP_CUSTOM_PATTERN_DELETE"; requestId: string; patternId: string }
  | { type: "POPUP_COMMUNITY_ACCOUNT_GET"; requestId: string }
  | { type: "POPUP_COMMUNITY_ACCOUNT_LINK_FREE"; requestId: string }
  | { type: "POPUP_COMMUNITY_ACCOUNT_UNLINK"; requestId: string }
  | { type: "POPUP_COMMUNITY_CONTRIBUTE"; requestId: string; patternId: string }
  | { type: "POPUP_COMMUNITY_FETCH_COMMUNITY_RULES"; requestId: string }
  | { type: "POPUP_API_CONNECT"; requestId: string; apiUrl?: string; token?: string }
  | { type: "POPUP_API_DISCONNECT"; requestId: string }
  | { type: "POPUP_API_GET_STATUS"; requestId: string }
  | { type: "POPUP_API_SYNC_POLICY"; requestId: string }
  | { type: "POPUP_API_SUBMIT_LOGIC"; requestId: string; patternId: string }
  | { type: "POPUP_OAUTH_CONNECT"; requestId: string }
  | { type: "POPUP_OAUTH_CALLBACK"; requestId: string; code: string; state: string }
  | {
      type: "POPUP_OAUTH_STATUS";
      requestId: string;
      connected: boolean;
      message?: string;
      tenantId?: string;
      tenantName?: string;
      apiUrl?: string;
      capabilities?: string[];
    };

export interface ScanSettingsMessage {
  enabledCategories: FindingCategory[];
  maxVisibleChars: number;
  maxNodeChars: number;
  maskPlaceholders: boolean;
  /** Session timeout in milliseconds, or 0 for "never". */
  sessionTimeoutMs: number;
}

export type WorkerMessage =
  | { type: "SCAN_PAGE"; requestId: string; mode: ScanMode; sessionId: string; settings: ScanSettingsMessage }
  | { type: "SCAN_RESULT"; requestId: string; sessionId: string; findings: Finding[]; stats: ScanStats }
  | { type: "CONTENT_ERROR"; requestId: string; sessionId: string; code: string; userMessage: string }
  | { type: "APPLY_MASKS"; requestId: string; sessionId: string; findingIds: string[] }
  | { type: "REMOVE_MASKS"; requestId: string; sessionId: string }
  | { type: "COPY_REDACTED_TEXT"; requestId: string; sessionId: string; findingIds: string[] }
  | { type: "COPY_REDACTED_TEXT_RESULT"; requestId: string; sessionId: string; text: string }
  | { type: "CONTEXT_REDACT_SELECTION"; requestId: string; selectionText?: string; settings?: ScanSettingsMessage }
  | { type: "CONTEXT_MASK_SELECTION"; requestId: string; selectionText?: string; settings?: ScanSettingsMessage }
  /** Async OCR/PDF findings from a visual-capture queue item (content → SW). */
  | { type: "SCAN_PAGE_VISUAL_RESULT"; requestId: string; sessionId: string; sourceId: string; findings: Finding[] }
  /** Coverage status broadcast from the SW to the popup after all async media results are merged. */
  | { type: "POPUP_SCAN_COVERAGE"; requestId: string; coverageStatus: string; deferredMediaCount: number };


export type ExtensionMessage = PopupMessage | WorkerMessage | PopupFromWorker;

/**
 * The three states a document redaction moves through, in order.
 *
 * They are deliberately distinct because they carry different guarantees:
 *   - detected:  values were found on the page. Nothing has been removed yet.
 *   - redacted:  an output artifact exists with boxes painted.
 *   - verified:  the output was re-read and the boxes confirmed covered.
 *
 * "Redacted" without "verified" is a claim about work done, not about the file.
 * Collapsing the two is how a redaction tool ends up confidently handing back a
 * document that still shows the value it promised to remove.
 */
export type DocRedactionStage = "detected" | "redacted" | "verified";

export interface PopupState {
  mode: ScanMode;
  scanning: boolean;
  findings: Finding[];
  scanned: boolean;
  truncated: boolean;
  visibleChars: number;
  /**
   * Document-sized images on the page, reported only when a scan read no text.
   * A page that is an image has nothing else to offer, so the popup turns these
   * into a route into the Document Studio rather than reporting a false
   * all-clear.
   */
  imageCandidates?: ImageCandidate[];
  error?: { code: string; userMessage: string };
  consentRequired: boolean;
  sessionId?: string;
}

/** One processed document page for the review UI (thumbnails only, no raw text). */
export interface DocPageMeta {
  index: number;
  widthPx: number;
  heightPx: number;
  /**
   * Key of the scaled-down page image in the shared document store; the popup
   * resolves it to an object URL. Carrying the image itself would exceed
   * MAX_MESSAGE_BYTES and cause the whole message to be rejected.
   */
  previewKey: string;
  /**
   * Key of the real-resolution page image used by the full-screen review page.
   *
   * Optional because a session persisted by an older build has no such key, and
   * a restored session must still open; the review surface falls back to
   * `previewKey` when it is absent or its bytes have gone.
   */
  pageImageKey?: string;
  findings: Finding[];
}

export type PopupFromWorker =
  | { type: "POPUP_STATE"; requestId: string; state: PopupState }
  | { type: "POPUP_COPY_RESULT"; requestId: string; text: string }
  | {
      type: "POPUP_AUDIT_EXPORT";
      requestId: string;
      jsonl: string;
      signatureBase64: string;
      publicKeyJwk: JsonWebKey;
      exportedAt: string;
      eventCount: number;
    }
  | { type: "POPUP_UNDO_DONE"; requestId: string; canUndo: boolean }
  | {
      type: "POPUP_DOC_STATE";
      requestId: string;
      docId: string;
      name: string;
      fileKey: string;
      mimeType: string;
      kind: DocKind;
      pages: DocPageMeta[];
      error?: { code: string; userMessage: string };
    }
  | {
      type: "POPUP_DOC_DONE";
      requestId: string;
      outputName: string;
      outputBytesBase64?: string;
      outputMimeType?: string;
      /**
       * Set when the redacted pages were staged for the print view. It is a
       * store key, not page content, so the message stays well inside the
       * runtime size budget. Absent means the print view is unavailable.
       */
      printFileKey?: string;
    }
  | {
      type: "POPUP_DOC_STATUS";
      requestId: string;
      stage: DocRedactionStage;
      /** How many regions were painted, for the "redacted" stage. */
      paintedRegions?: number;
      /** How many regions were confirmed covered, when the stage can be counted. */
      verifiedRegions?: number;
      checkedRegions?: number;
      /**
       * How the check was performed. Surfaced so the UI states exactly what was
       * confirmed instead of implying the file was fully inspected.
       */
      method?: RedactionVerifyMethod;
      /** Present when the stage could not be reached; user-facing text. */
      problem?: string;
    }
  /**
   * The worker staged an image lifted off the page and the popup should now
   * preview it. `degraded` marks a rendered capture rather than the original
   * file, where OCR quality is limited by what was on screen.
   */
  | {
      type: "POPUP_DOC_CAPTURE_READY";
      requestId: string;
      fileKey: string;
      name: string;
      mimeType: string;
      kind: "image";
      source: "original" | "capture";
      degraded: boolean;
    }
  | { type: "POPUP_DOC_ERROR"; requestId: string; code: string; userMessage: string }
  | { type: "POPUP_NOTIFICATIONS_STATE"; requestId: string; granted: boolean }
  | {
      type: "POPUP_ACCOUNT_STATE";
      requestId: string;
      gatewayOrigin: string | null;
      linked: boolean;
      /**
       * True when a live API key credential is present in chrome.storage.session
       * this browser session. "linked" (metadata) can outlive the credential: on
       * a fresh browser start the account is still linked but no key is available
       * until the user re-enters it. Never implies the key is stored at rest.
       */
      credentialAvailable?: boolean;
      accountLabel?: string;
      error?: { code: string; userMessage: string };
    }
  | { type: "POPUP_ACCOUNT_PURCHASE_URL"; requestId: string; url: string }
  | {
      type: "POPUP_OAUTH_STATUS";
      requestId: string;
      connected: boolean;
      message?: string;
      tenantId?: string;
      tenantName?: string;
      apiUrl?: string;
      capabilities?: string[];
    }
  | { type: "POPUP_WIZARD_ANALYSIS_RESULT"; requestId: string; proposals: WizardAnalysis[] }
  | { type: "POPUP_WIZARD_TEST_RESULT"; requestId: string; testResult: PatternTestResult[] }
  | { type: "POPUP_CUSTOM_PATTERNS_STATE"; requestId: string; patterns: CustomPattern[] }
  | { type: "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE"; requestId: string; account: CommunityAccount | null }
  | { type: "POPUP_COMMUNITY_CONTRIBUTE_RESULT"; requestId: string; success: boolean; ruleId?: string; error?: string }
  | { type: "POPUP_COMMUNITY_COMMUNITY_RULES_STATE"; requestId: string; rules: CommunityRule[]; error?: string }
  | {
      type: "POPUP_API_STATUS_STATE";
      requestId: string;
      connectionState: string;
      tenantId?: string;
      tenantName?: string;
      apiUrl: string;
      capabilities: string[];
      error?: string;
    }
  | {
      type: "POPUP_API_POLICY_STATE";
      requestId: string;
      success: boolean;
      policyId?: string;
      policyVersion?: string;
      rulesCount?: number;
      error?: string;
    }
  | {
      type: "POPUP_API_SUBMIT_RESULT";
      requestId: string;
      success: boolean;
      submissionId?: string;
      error?: string;
    };

export const MESSAGE_TYPES = new Set<string>([
  "POPUP_SCAN",
  "POPUP_APPLY_MASKS",
  "POPUP_REMOVE_MASKS",
  "POPUP_COPY_REDACTED",
  "POPUP_CLEAR_DATA",
  "POPUP_GET_STATE",
  "POPUP_SET_MODE",
  "POPUP_DOC_PREVIEW",
  "POPUP_DOC_REDACT",
  "POPUP_DOC_CLEAR",
  "POPUP_DOC_CANCEL",
  "POPUP_DOC_PRINT",
  "POPUP_DOC_STATUS",
  "POPUP_DOC_DELIVERY_REPORT",
  "SCAN_PAGE",
  "SCAN_RESULT",
  "CONTENT_ERROR",
  "APPLY_MASKS",
  "REMOVE_MASKS",
  "COPY_REDACTED_TEXT",
  "COPY_REDACTED_TEXT_RESULT",
  "CONTEXT_REDACT_SELECTION",
  "CONTEXT_MASK_SELECTION",
  "POPUP_STATE",
  "POPUP_COPY_RESULT",
  "POPUP_DOC_STATE",
  "POPUP_DOC_DONE",
  "POPUP_DOC_ERROR",
  "POPUP_DOC_CLEAR",
  "POPUP_DOC_STATUS",
  "POPUP_DOC_CAPTURE_IMAGE",
  "POPUP_DOC_CAPTURE_READY",
  "POPUP_DOC_DELIVERY_REPORT",
  "POPUP_EXPORT_AUDIT",
  "POPUP_AUDIT_EXPORT",
  "POPUP_UNDO_MASKS",
  "POPUP_UNDO_DONE",
  "POPUP_SET_NOTIFICATIONS",
  "POPUP_ACCOUNT_SAVE",
  "POPUP_ACCOUNT_CLEAR",
  "POPUP_ACCOUNT_PURCHASE",
  "POPUP_NOTIFICATIONS_STATE",
  "POPUP_ACCOUNT_STATE",
  "POPUP_ACCOUNT_PURCHASE_URL",
  "POPUP_WIZARD_ANALYZE",
  "POPUP_WIZARD_TEST",
  "POPUP_CUSTOM_PATTERNS_GET",
  "POPUP_CUSTOM_PATTERN_SAVE",
  "POPUP_CUSTOM_PATTERN_DELETE",
  "POPUP_COMMUNITY_ACCOUNT_GET",
  "POPUP_COMMUNITY_ACCOUNT_LINK_FREE",
  "POPUP_COMMUNITY_ACCOUNT_UNLINK",
  "POPUP_COMMUNITY_CONTRIBUTE",
  "POPUP_COMMUNITY_FETCH_COMMUNITY_RULES",
  "POPUP_WIZARD_ANALYSIS_RESULT",
  "POPUP_WIZARD_TEST_RESULT",
  "POPUP_CUSTOM_PATTERNS_STATE",
  "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE",
  "POPUP_COMMUNITY_CONTRIBUTE_RESULT",
  "POPUP_COMMUNITY_COMMUNITY_RULES_STATE",
  "POPUP_API_CONNECT",
  "POPUP_API_DISCONNECT",
  "POPUP_API_GET_STATUS",
  "POPUP_API_SYNC_POLICY",
  "POPUP_API_SUBMIT_LOGIC",
  "POPUP_OAUTH_CONNECT",
  "POPUP_OAUTH_CALLBACK",
  "POPUP_OAUTH_STATUS",
  "POPUP_API_STATUS_STATE",
  "POPUP_API_POLICY_STATE",
  "POPUP_API_SUBMIT_RESULT",
  // Multi-format acquisition pipeline messages (Layer 2–5 async OCR/PDF results)
  "SCAN_PAGE_VISUAL_RESULT",
  "POPUP_SCAN_COVERAGE",
]);

export const MAX_MESSAGE_BYTES = 64 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}