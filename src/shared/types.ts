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
  | "custom";

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

export type ScanMode = "local" | "cloud";

export interface ScanStats {
  visibleChars: number;
  /** Characters of accessibility-attribute text also analyzed. */
  attrChars?: number;
  truncated: boolean;
  startedAt?: number;
  finishedAt?: number;
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
  | { type: "POPUP_DOC_REDACT"; requestId: string; docId: string; fileKey: string; name: string; mimeType: string; kind: DocKind; boxes: { pageIndex: number; rects: Rect[] }[]; findingIds: string[] }
  | { type: "POPUP_DOC_CLEAR"; requestId: string; docId: string }
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
  | { type: "POPUP_COMMUNITY_FETCH_COMMUNITY_RULES"; requestId: string };

export interface ScanSettingsMessage {
  enabledCategories: FindingCategory[];
  maxVisibleChars: number;
  maxNodeChars: number;
  maskPlaceholders: boolean;
}

export type WorkerMessage =
  | { type: "SCAN_PAGE"; requestId: string; mode: ScanMode; sessionId: string; settings: ScanSettingsMessage }
  | { type: "SCAN_RESULT"; requestId: string; sessionId: string; findings: Finding[]; stats: ScanStats }
  | { type: "CONTENT_ERROR"; requestId: string; sessionId: string; code: string; userMessage: string }
  | { type: "APPLY_MASKS"; requestId: string; sessionId: string; findingIds: string[] }
  | { type: "REMOVE_MASKS"; requestId: string; sessionId: string }
  | { type: "COPY_REDACTED_TEXT"; requestId: string; sessionId: string; findingIds: string[] }
  | { type: "COPY_REDACTED_TEXT_RESULT"; requestId: string; sessionId: string; text: string };

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
  error?: { code: string; userMessage: string };
  consentRequired: boolean;
  sessionId?: string;
}

/** One processed document page for the review UI (thumbnails only, no raw text). */
export interface DocPageMeta {
  index: number;
  widthPx: number;
  heightPx: number;
  /** Scaled-down page image for review; findings carry full-res rects. */
  previewDataUrl: string;
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
  | { type: "POPUP_DOC_DONE"; requestId: string; outputName: string; outputBytesBase64?: string; outputMimeType?: string }
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
  | { type: "POPUP_WIZARD_ANALYSIS_RESULT"; requestId: string; proposals: WizardAnalysis[] }
  | { type: "POPUP_WIZARD_TEST_RESULT"; requestId: string; testResult: PatternTestResult[] }
  | { type: "POPUP_CUSTOM_PATTERNS_STATE"; requestId: string; patterns: CustomPattern[] }
  | { type: "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE"; requestId: string; account: CommunityAccount | null }
  | { type: "POPUP_COMMUNITY_CONTRIBUTE_RESULT"; requestId: string; success: boolean; ruleId?: string; error?: string }
  | { type: "POPUP_COMMUNITY_COMMUNITY_RULES_STATE"; requestId: string; rules: CommunityRule[]; error?: string };

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
  "POPUP_DOC_STATUS",
  "POPUP_DOC_DELIVERY_REPORT",
  "SCAN_PAGE",
  "SCAN_RESULT",
  "CONTENT_ERROR",
  "APPLY_MASKS",
  "REMOVE_MASKS",
  "COPY_REDACTED_TEXT",
  "COPY_REDACTED_TEXT_RESULT",
  "POPUP_STATE",
  "POPUP_COPY_RESULT",
  "POPUP_DOC_STATE",
  "POPUP_DOC_DONE",
  "POPUP_DOC_ERROR",
  "POPUP_DOC_CLEAR",
  "POPUP_DOC_STATUS",
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
]);

export const MAX_MESSAGE_BYTES = 64 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}