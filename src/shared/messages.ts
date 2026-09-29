// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import {
  isRecord,
  MAX_MESSAGE_BYTES,
  MESSAGE_TYPES,
} from "./types.js";
import type { DocKind, ExtensionMessage, Finding, ScanMode, DocPageMeta, RedactionOptions, RedactionStyle, DocRedactionStage } from "./types.js";
import type { RedactionVerifyMethod } from "../document-pipeline/verify.js";
import { isAllowedGatewayOrigin, isCategory } from "./settings.js";
import { isPreviewKey } from "./docStore.js";
import { parseCustomPattern } from "./customPatterns.js";
import type { CustomPattern } from "./customPatterns.js";
import type { FindingCategory, PopupState } from "./types.js";
import type { PatternTestResult, WizardAnalysis } from "./wizardAnalyzer.js";

export type ValidationResult =
  | { ok: true; message: ExtensionMessage }
  | { ok: false; error: string };

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_RE.test(value);
}

function isMode(value: unknown): value is ScanMode {
  return value === "local" || value === "cloud";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isDocKind(value: unknown): value is DocKind {
  return value === "pdf" || value === "image" || value === "docx";
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

function isFileKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.x >= 0 &&
    value.y >= 0 &&
    value.width >= 0 &&
    value.height >= 0
  );
}

const FINDING_ID_RE = /^[a-z][a-z0-9:_-]{0,127}$/;
const NODE_ID_RE = /^(?:[A-Za-z0-9][A-Za-z0-9:_-]{0,127})?$/;
const ATTRIBUTE_NAMES = new Set(["aria-label", "alt", "placeholder", "title"]);
const ALL_MASKED_PREVIEW_RE = /^[\s*]+$/;

function isMaskedPreview(category: FindingCategory, preview: string): boolean {
  if (preview.length === 0 || preview.length > 256) return false;
  switch (category) {
    case "email":
      return /^(?:[A-Za-z0-9._%+-]{0,2}\*{3,}@[A-Za-z0-9.-]{1,190}|[\s*]+)$/.test(preview);
    case "phone":
      return /^(?:\*{3}-\*{3}-\d{4}|[\s*]+)$/.test(preview);
    case "ssn":
      return /^(?:\*{3}-\*{2}-\d{4}|[\s*]+)$/.test(preview);
    case "payment_card":
      return /^(?:\*{12}\d{4}|[\s*]+)$/.test(preview);
    case "npi":
      return /^(?:\*{6}-\d{4}|[\s*]+)$/.test(preview);
    case "mbi":
      return /^(?:\*{7}\d{4}|[\s*]+)$/.test(preview);
    case "dob":
      return preview === "**/**/****";
    case "dea":
      return preview === "*********";
    case "secrets":
      return /^(?:[^\s*]\*{3,}|[\s*]+)$/.test(preview);
    case "canadian_sin":
      return /^(?:\*{3}-\*{3}-\d{3}|[\s*]+)$/.test(preview);
    case "uk_nhs":
      return /^(?:\*{3}-\*{3}-\d{4}|[\s*]+)$/.test(preview);
    case "aadhaar":
      return /^(?:\*{4}-\*{4}-\d{4}|[\s*]+)$/.test(preview);
    case "pan_india":
      return /^(?:\*{5}[0-9A-Za-z]{5}|[\s*]+)$/.test(preview);
    case "australian_tfn":
      return /^(?:\*{3}-\*{3}-\d{2,3}|[\s*]+)$/.test(preview);
    case "cpf":
      return /^(?:\*{3}\.\*{3}\.\*{3}-\d{2}|[\s*]+)$/.test(preview);
    case "possible_name":
    case "medical_record_number":
    case "member_id":
    case "address":
    case "custom":
      return ALL_MASKED_PREVIEW_RE.test(preview);
    default:
      return false;
  }
}

function isDocPageMeta(value: unknown): value is DocPageMeta {
  if (!isRecord(value)) return false;
  return (
    typeof value.index === "number" &&
    typeof value.widthPx === "number" &&
    typeof value.heightPx === "number" &&
    isPreviewKey(value.previewKey) &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding)
  );
}

function isFinding(value: unknown): value is Finding {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !FINDING_ID_RE.test(value.id) || !isCategory(value.category)) return false;
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return false;
  if (
    value.source !== "local-rules" &&
    value.source !== "local-model" &&
    value.source !== "gateway" &&
    value.source !== "attr" &&
    value.source !== "custom-pattern"
  ) return false;
  if (typeof value.preview !== "string" || !isMaskedPreview(value.category, value.preview)) return false;
  if (
    value.contextPreview !== undefined &&
    (typeof value.contextPreview !== "string" || value.contextPreview.length > 512 || !/^[\s*]*$/.test(value.contextPreview))
  ) return false;
  if (typeof value.nodeId !== "string" || !NODE_ID_RE.test(value.nodeId)) return false;
  if (
    typeof value.startOffset !== "number" ||
    typeof value.endOffset !== "number" ||
    !Number.isSafeInteger(value.startOffset) ||
    !Number.isSafeInteger(value.endOffset) ||
    value.startOffset < 0 ||
    value.endOffset < value.startOffset
  ) return false;
  if (!Array.isArray(value.rects) || value.rects.length > 1000 || !value.rects.every(isRect)) return false;
  if (value.source === "attr") {
    if (typeof value.attribute !== "string" || !ATTRIBUTE_NAMES.has(value.attribute) || value.selected !== false) return false;
  } else if (value.attribute !== undefined) return false;
  return typeof value.selected === "boolean";
}

function normalizeFindingArray(value: unknown): Finding[] | null {
  if (!Array.isArray(value) || !value.every(isFinding)) return null;
  return value.map((finding) => ({
    id: finding.id,
    category: finding.category,
    confidence: finding.confidence,
    source: finding.source,
    preview: finding.preview,
    nodeId: finding.nodeId,
    startOffset: finding.startOffset,
    endOffset: finding.endOffset,
    rects: finding.rects.map((rect) => ({ ...rect })),
    ...(finding.contextPreview !== undefined ? { contextPreview: finding.contextPreview } : {}),
    ...(finding.attribute !== undefined ? { attribute: finding.attribute } : {}),
    selected: finding.selected,
  }));
}

function normalizeScanStats(value: unknown): { visibleChars: number; attrChars?: number; truncated: boolean; startedAt?: number; finishedAt?: number } | null {
  if (!isRecord(value) || typeof value.visibleChars !== "number" || !Number.isSafeInteger(value.visibleChars) || value.visibleChars < 0) return null;
  if (value.attrChars !== undefined && (typeof value.attrChars !== "number" || !Number.isSafeInteger(value.attrChars) || value.attrChars < 0)) return null;
  if (typeof value.truncated !== "boolean") return null;
  if (value.startedAt !== undefined && (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt))) return null;
  if (value.finishedAt !== undefined && (typeof value.finishedAt !== "number" || !Number.isFinite(value.finishedAt))) return null;
  return {
    visibleChars: value.visibleChars,
    ...(value.attrChars !== undefined ? { attrChars: value.attrChars } : {}),
    truncated: value.truncated,
    ...(value.startedAt !== undefined ? { startedAt: value.startedAt } : {}),
    ...(value.finishedAt !== undefined ? { finishedAt: value.finishedAt } : {}),
  };
}

function normalizeWizardAnalysis(value: unknown): WizardAnalysis | null {
  if (!isRecord(value) || !isCategory(value.category) || typeof value.proposedPattern !== "string" || value.proposedPattern.length > 512 || typeof value.proposedFlags !== "string") return null;
  if (!Array.isArray(value.characteristics) || !value.characteristics.every((item) => isRecord(item) && typeof item.label === "string" && item.label.length <= 200 && (item.detail === undefined || (typeof item.detail === "string" && item.detail.length <= 500)))) return null;
  if (!Array.isArray(value.matchResults) || !value.matchResults.every((item) => isRecord(item) && typeof item.exampleIndex === "number" && Number.isSafeInteger(item.exampleIndex) && item.exampleIndex >= 0 && typeof item.matched === "boolean" && typeof item.matchCount === "number" && Number.isSafeInteger(item.matchCount) && item.matchCount >= 0 && item.matchCount <= 1000)) return null;
  if (typeof value.qualityScore !== "number" || !Number.isFinite(value.qualityScore) || value.qualityScore < 0 || value.qualityScore > 1) return null;
  if (!Array.isArray(value.limitations) || !value.limitations.every((item) => typeof item === "string" && item.length <= 500)) return null;
  return {
    category: value.category,
    proposedPattern: value.proposedPattern,
    proposedFlags: value.proposedFlags,
    characteristics: value.characteristics.map((item) => ({ label: item.label as string, ...(item.detail !== undefined ? { detail: item.detail as string } : {}) })),
    matchResults: value.matchResults.map((item) => ({ exampleIndex: item.exampleIndex as number, matched: item.matched as boolean, matchCount: item.matchCount as number })),
    qualityScore: value.qualityScore,
    limitations: value.limitations as string[],
  };
}

function normalizePatternTestResults(value: unknown): PatternTestResult[] | null {
  if (!Array.isArray(value)) return null;
  const results: PatternTestResult[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.caseIndex !== "number" || !Number.isSafeInteger(item.caseIndex) || item.caseIndex < 0 || typeof item.matched !== "boolean" || typeof item.matchCount !== "number" || !Number.isSafeInteger(item.matchCount) || item.matchCount < 0 || item.matchCount > 1000) return null;
    results.push({ caseIndex: item.caseIndex, matched: item.matched, matchCount: item.matchCount });
  }
  return results;
}

function normalizeCustomPatterns(value: unknown): CustomPattern[] | null {
  if (!Array.isArray(value)) return null;
  const patterns: CustomPattern[] = [];
  for (const item of value) {
    const parsed = parseCustomPattern(item);
    if (!parsed.ok) return null;
    patterns.push(parsed.pattern);
  }
  return patterns;
}

/** Serialized size guard - reject oversized payloads before trusting them. */
function withinSizeLimit(raw: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(raw).length <= MAX_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

function isScanSettings(value: unknown): value is { enabledCategories: FindingCategory[]; maxVisibleChars: number; maxNodeChars: number; maskPlaceholders: boolean; sessionTimeoutMs: number } {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.enabledCategories) &&
    value.enabledCategories.every(isCategory) &&
    typeof value.maxVisibleChars === "number" &&
    typeof value.maxNodeChars === "number" &&
    typeof value.maskPlaceholders === "boolean" &&
    typeof value.sessionTimeoutMs === "number" &&
    value.sessionTimeoutMs >= 0
  );
}

function normalizePopupState(value: unknown): PopupState | null {
  if (!isRecord(value) || (value.mode !== "local" && value.mode !== "cloud") || typeof value.scanning !== "boolean" || typeof value.scanned !== "boolean" || typeof value.truncated !== "boolean" || typeof value.visibleChars !== "number" || !Number.isSafeInteger(value.visibleChars) || value.visibleChars < 0) return null;
  const findings = normalizeFindingArray(value.findings);
  if (!findings || typeof value.consentRequired !== "boolean") return null;
  if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.length > 128)) return null;
  let error: { code: string; userMessage: string } | undefined;
  if (value.error !== undefined) {
    if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.userMessage !== "string" || value.error.code.length > 100 || value.error.userMessage.length > 500) return null;
    error = { code: value.error.code, userMessage: value.error.userMessage };
  }
  return {
    mode: value.mode,
    scanning: value.scanning,
    findings,
    scanned: value.scanned,
    truncated: value.truncated,
    visibleChars: value.visibleChars,
    ...(error ? { error } : {}),
    consentRequired: value.consentRequired,
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
  };
}

function isApiKey(value: unknown): value is string {
  return typeof value === "string" && /^gw_(live|test)_[A-Za-z0-9]{8,}$/.test(value);
}

function normalizeCustomPattern(value: unknown): CustomPattern | null {
  const parsed = parseCustomPattern(value);
  return parsed.ok ? parsed.pattern : null;
}

export function normalizeRedactionOptions(value: unknown): RedactionOptions | undefined {
  if (!isRecord(value)) return undefined;
  let style: RedactionStyle | undefined;
  if (value.style === "blackout" || value.style === "whiteout" || value.style === "stamp") {
    style = value.style;
  }
  let stampText: string | undefined;
  if (typeof value.stampText === "string" && value.stampText.length <= 100) {
    stampText = value.stampText;
  }
  let padding: number | undefined;
  if (typeof value.padding === "number" && Number.isFinite(value.padding) && value.padding >= 0 && value.padding <= 100) {
    padding = value.padding;
  }
  let fillColor: string | undefined;
  if (typeof value.fillColor === "string" && /^#[0-9a-fA-F]{6}$/.test(value.fillColor)) {
    fillColor = value.fillColor;
  }
  return {
    ...(style ? { style } : {}),
    ...(stampText !== undefined ? { stampText } : {}),
    ...(padding !== undefined ? { padding } : {}),
    ...(fillColor ? { fillColor } : {}),
  };
}

export function validateMessage(raw: unknown): ValidationResult {
  if (!isRecord(raw)) return { ok: false, error: "Message must be an object" };
  if (!withinSizeLimit(raw)) return { ok: false, error: "Message exceeds size limit" };

  const type = raw.type;
  if (typeof type !== "string" || !MESSAGE_TYPES.has(type)) {
    return { ok: false, error: `Unknown message type: ${String(type)}` };
  }

  if (!isRequestId(raw.requestId)) {
    return { ok: false, error: "Invalid or missing requestId" };
  }

  const requestId = raw.requestId;

  switch (type) {
    case "POPUP_SCAN": {
      if (!isMode(raw.mode)) return { ok: false, error: "Invalid mode" };
      return { ok: true, message: { type, requestId, mode: raw.mode } };
    }
    case "POPUP_APPLY_MASKS": {
      if (!isStringArray(raw.findingIds)) return { ok: false, error: "Invalid findingIds" };
      return { ok: true, message: { type, requestId, findingIds: raw.findingIds } };
    }
    case "POPUP_REMOVE_MASKS":
    case "POPUP_CLEAR_DATA":
    case "POPUP_GET_STATE":
      return { ok: true, message: { type, requestId } };
    case "POPUP_COPY_REDACTED": {
      if (!isStringArray(raw.findingIds)) return { ok: false, error: "Invalid findingIds" };
      return { ok: true, message: { type, requestId, findingIds: raw.findingIds } };
    }
    case "POPUP_SET_MODE": {
      if (!isMode(raw.mode)) return { ok: false, error: "Invalid mode" };
      return { ok: true, message: { type, requestId, mode: raw.mode } };
    }
    case "POPUP_DOC_PREVIEW": {
      if (!isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      if (!isName(raw.name)) return { ok: false, error: "Invalid name" };
      if (typeof raw.mimeType !== "string" || !raw.mimeType) return { ok: false, error: "Invalid mimeType" };
      if (!isDocKind(raw.kind)) return { ok: false, error: "Invalid kind" };
      return { ok: true, message: { type, requestId, fileKey: raw.fileKey, name: raw.name, mimeType: raw.mimeType, kind: raw.kind } };
    }
    case "POPUP_DOC_REDACT": {
      if (!isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      if (typeof raw.docId !== "string" || !raw.docId) return { ok: false, error: "Invalid docId" };
      if (!isName(raw.name)) return { ok: false, error: "Invalid name" };
      if (typeof raw.mimeType !== "string" || !raw.mimeType) return { ok: false, error: "Invalid mimeType" };
      if (!isDocKind(raw.kind)) return { ok: false, error: "Invalid kind" };
      if (
        !Array.isArray(raw.boxes) ||
        raw.boxes.some(
          (b) =>
            !isRecord(b) ||
            typeof b.pageIndex !== "number" ||
            !Array.isArray(b.rects) ||
            !b.rects.every(isRect)
        )
      ) {
        return { ok: false, error: "Invalid boxes" };
      }
      if (!isStringArray(raw.findingIds)) return { ok: false, error: "Invalid findingIds" };
      const options = normalizeRedactionOptions(raw.options);
      return {
        ok: true,
        message: {
          type,
          requestId,
          docId: raw.docId,
          fileKey: raw.fileKey,
          name: raw.name,
          mimeType: raw.mimeType,
          kind: raw.kind,
          boxes: raw.boxes,
          findingIds: raw.findingIds,
          ...(options ? { options } : {}),
        },
      };
    }
    case "POPUP_DOC_PRINT": {
      // Opens the read-only print/PDF view for an already-redacted document.
      // The key identifies a manifest in the shared store; the page fetches the
      // page bitmaps itself, so no image ever crosses this message boundary.
      if (!isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      return { ok: true, message: { type, requestId, fileKey: raw.fileKey } };
    }
    case "POPUP_DOC_DELIVERY_REPORT": {
      if (typeof raw.delivered !== "boolean") return { ok: false, error: "Invalid delivered" };
      return { ok: true, message: { type, requestId, delivered: raw.delivered } };
    }
    case "POPUP_DOC_CANCEL": {
      if (typeof raw.docId !== "string" || !raw.docId) return { ok: false, error: "Invalid docId" };
      return { ok: true, message: { type, requestId, docId: raw.docId } };
    }
    case "SCAN_PAGE": {
      if (!isMode(raw.mode)) return { ok: false, error: "Invalid mode" };
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      if (!isScanSettings(raw.settings)) return { ok: false, error: "Invalid settings" };
      return { ok: true, message: { type, requestId, mode: raw.mode, sessionId: raw.sessionId, settings: raw.settings } };
    }
    case "SCAN_RESULT": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      const findings = normalizeFindingArray(raw.findings);
      if (!findings) return { ok: false, error: "Invalid findings" };
      const stats = normalizeScanStats(raw.stats);
      if (!stats) return { ok: false, error: "Invalid stats" };
      return { ok: true, message: { type, requestId, sessionId: raw.sessionId, findings, stats } };
    }
    case "CONTENT_ERROR": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      if (typeof raw.code !== "string") return { ok: false, error: "Invalid error code" };
      if (typeof raw.userMessage !== "string") return { ok: false, error: "Invalid userMessage" };
      return { ok: true, message: { type, requestId, sessionId: raw.sessionId, code: raw.code, userMessage: raw.userMessage } };
    }
    case "APPLY_MASKS":
    case "COPY_REDACTED_TEXT": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      if (!isStringArray(raw.findingIds)) return { ok: false, error: "Invalid findingIds" };
      return { ok: true, message: { type, requestId, sessionId: raw.sessionId, findingIds: raw.findingIds } };
    }
    case "REMOVE_MASKS": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      return { ok: true, message: { type, requestId, sessionId: raw.sessionId } };
    }
    case "COPY_REDACTED_TEXT_RESULT": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      if (typeof raw.text !== "string") return { ok: false, error: "Invalid text" };
      return { ok: true, message: { type, requestId, sessionId: raw.sessionId, text: raw.text } };
    }
    case "CONTEXT_REDACT_SELECTION":
    case "CONTEXT_MASK_SELECTION": {
      if (raw.selectionText !== undefined && typeof raw.selectionText !== "string") {
        return { ok: false, error: "Invalid selectionText" };
      }
      if (raw.settings !== undefined && !isScanSettings(raw.settings)) {
        return { ok: false, error: "Invalid settings" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          ...(raw.selectionText !== undefined ? { selectionText: raw.selectionText as string } : {}),
          ...(raw.settings !== undefined ? { settings: raw.settings } : {}),
        },
      };
    }
    case "POPUP_STATE": {
      const state = normalizePopupState(raw.state);
      if (!state) return { ok: false, error: "Invalid state" };
      return { ok: true, message: { type, requestId, state } };
    }
    case "POPUP_COPY_RESULT": {
      if (typeof raw.text !== "string") return { ok: false, error: "Invalid text" };
      return { ok: true, message: { type, requestId, text: raw.text } };
    }
    case "POPUP_UNDO_DONE": {
      if (typeof raw.canUndo !== "boolean") return { ok: false, error: "Invalid canUndo" };
      return { ok: true, message: { type, requestId, canUndo: raw.canUndo } };
    }
    case "POPUP_DOC_STATE": {
      if (typeof raw.docId !== "string" || !raw.docId) return { ok: false, error: "Invalid docId" };
      if (!isName(raw.name)) return { ok: false, error: "Invalid name" };
      if (!isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      if (typeof raw.mimeType !== "string" || !raw.mimeType) return { ok: false, error: "Invalid mimeType" };
      if (!isDocKind(raw.kind)) return { ok: false, error: "Invalid kind" };
      if (!Array.isArray(raw.pages) || !raw.pages.every(isDocPageMeta)) return { ok: false, error: "Invalid pages" };
      if (raw.error !== undefined && !isRecord(raw.error)) return { ok: false, error: "Invalid error" };
      return { ok: true, message: { type, requestId, docId: raw.docId, name: raw.name, fileKey: raw.fileKey, mimeType: raw.mimeType, kind: raw.kind, pages: raw.pages } };
    }
    case "POPUP_DOC_DONE": {
      if (!isName(raw.outputName)) return { ok: false, error: "Invalid outputName" };
      if (raw.outputBytesBase64 !== undefined && typeof raw.outputBytesBase64 !== "string") return { ok: false, error: "Invalid outputBytesBase64" };
      if (raw.outputMimeType !== undefined && typeof raw.outputMimeType !== "string") return { ok: false, error: "Invalid outputMimeType" };
      // Tells the UI a print view is available. The handle is a store key, not
      // page content, so it stays inside the message size budget.
      const printFileKey = raw.printFileKey;
      if (printFileKey !== undefined && !isFileKey(printFileKey)) return { ok: false, error: "Invalid printFileKey" };
      return { ok: true, message: { type, requestId, outputName: raw.outputName, ...(raw.outputBytesBase64 ? { outputBytesBase64: raw.outputBytesBase64 as string } : {}), ...(raw.outputMimeType ? { outputMimeType: raw.outputMimeType as string } : {}), ...(printFileKey ? { printFileKey } : {}) } };
    }
    case "POPUP_DOC_ERROR": {
      if (typeof raw.code !== "string" || !raw.code) return { ok: false, error: "Invalid error code" };
      if (typeof raw.userMessage !== "string" || !raw.userMessage) return { ok: false, error: "Invalid userMessage" };
      return { ok: true, message: { type, requestId, code: raw.code, userMessage: raw.userMessage } };
    }
    case "POPUP_DOC_CLEAR": {
      if (typeof raw.docId !== "string" || !raw.docId) return { ok: false, error: "Invalid docId" };
      return { ok: true, message: { type, requestId, docId: raw.docId } };
    }
    case "POPUP_EXPORT_AUDIT":
    case "POPUP_UNDO_MASKS":
    case "POPUP_CUSTOM_PATTERNS_GET":
    case "POPUP_COMMUNITY_ACCOUNT_GET":
    case "POPUP_COMMUNITY_ACCOUNT_LINK_FREE":
    case "POPUP_COMMUNITY_ACCOUNT_UNLINK":
    case "POPUP_COMMUNITY_FETCH_COMMUNITY_RULES":
      return { ok: true, message: { type, requestId } };
    case "POPUP_WIZARD_ANALYZE": {
      if (!isStringArray(raw.positiveExamples)) return { ok: false, error: "Invalid positiveExamples" };
      if (!isStringArray(raw.negativeExamples)) return { ok: false, error: "Invalid negativeExamples" };
      return { ok: true, message: { type, requestId, positiveExamples: raw.positiveExamples, negativeExamples: raw.negativeExamples } };
    }
    case "POPUP_WIZARD_TEST": {
      if (typeof raw.regex !== "string") return { ok: false, error: "Invalid regex" };
      if (typeof raw.sampleText !== "string") return { ok: false, error: "Invalid sampleText" };
      return { ok: true, message: { type, requestId, regex: raw.regex, sampleText: raw.sampleText } };
    }
    case "POPUP_CUSTOM_PATTERN_SAVE": {
      const pattern = normalizeCustomPattern(raw.pattern);
      if (!pattern) return { ok: false, error: "Invalid pattern" };
      return { ok: true, message: { type, requestId, pattern } };
    }
    case "POPUP_CUSTOM_PATTERN_DELETE": {
      if (typeof raw.patternId !== "string") return { ok: false, error: "Invalid patternId" };
      return { ok: true, message: { type, requestId, patternId: raw.patternId } };
    }
    case "POPUP_COMMUNITY_CONTRIBUTE": {
      if (typeof raw.patternId !== "string") return { ok: false, error: "Invalid patternId" };
      return { ok: true, message: { type, requestId, patternId: raw.patternId } };
    }
    case "POPUP_WIZARD_ANALYSIS_RESULT": {
      if (!Array.isArray(raw.proposals)) return { ok: false, error: "Invalid proposals" };
      const proposals = raw.proposals.map(normalizeWizardAnalysis);
      if (proposals.some((proposal) => proposal === null)) return { ok: false, error: "Invalid proposals" };
      return { ok: true, message: { type, requestId, proposals: proposals as WizardAnalysis[] } };
    }
    case "POPUP_WIZARD_TEST_RESULT": {
      const testResult = normalizePatternTestResults(raw.testResult);
      if (!testResult) return { ok: false, error: "Invalid testResult" };
      return { ok: true, message: { type, requestId, testResult } };
    }
    case "POPUP_CUSTOM_PATTERNS_STATE": {
      const patterns = normalizeCustomPatterns(raw.patterns);
      if (!patterns) return { ok: false, error: "Invalid patterns" };
      return { ok: true, message: { type, requestId, patterns } };
    }
    case "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE": {
      return { ok: true, message: { type, requestId, account: (raw.account ?? null) as any } };
    }
    case "POPUP_COMMUNITY_CONTRIBUTE_RESULT": {
      if (typeof raw.success !== "boolean") return { ok: false, error: "Invalid success" };
      return { ok: true, message: { type, requestId, success: raw.success, ruleId: raw.ruleId as any, error: raw.error as any } };
    }
    case "POPUP_COMMUNITY_COMMUNITY_RULES_STATE": {
      if (!Array.isArray(raw.rules) && raw.error === undefined) return { ok: false, error: "Invalid rules" };
      return { ok: true, message: { type, requestId, rules: (raw.rules ?? []) as any, error: raw.error as any } };
    }
    case "POPUP_SET_NOTIFICATIONS": {
      if (typeof raw.enabled !== "boolean") return { ok: false, error: "Invalid enabled" };
      return { ok: true, message: { type, requestId, enabled: raw.enabled } };
    }
    case "POPUP_ACCOUNT_SAVE": {
      if (typeof raw.gatewayOrigin !== "string" || !isAllowedGatewayOrigin(raw.gatewayOrigin)) {
        return { ok: false, error: "Invalid gatewayOrigin" };
      }
      if (!isApiKey(raw.apiKey)) return { ok: false, error: "Invalid API key" };
      return { ok: true, message: { type, requestId, gatewayOrigin: raw.gatewayOrigin, apiKey: raw.apiKey } };
    }
    case "POPUP_ACCOUNT_CLEAR":
      return { ok: true, message: { type, requestId } };
    case "POPUP_ACCOUNT_PURCHASE": {
      if (typeof raw.planId !== "string" || !raw.planId || raw.planId.length > 128) return { ok: false, error: "Invalid planId" };
      return { ok: true, message: { type, requestId, planId: raw.planId } };
    }
    case "POPUP_NOTIFICATIONS_STATE": {
      if (typeof raw.granted !== "boolean") return { ok: false, error: "Invalid granted" };
      return { ok: true, message: { type, requestId, granted: raw.granted } };
    }
    case "POPUP_ACCOUNT_STATE": {
      if (raw.gatewayOrigin !== null && (typeof raw.gatewayOrigin !== "string" || !isAllowedGatewayOrigin(raw.gatewayOrigin))) {
        return { ok: false, error: "Invalid gatewayOrigin" };
      }
      if (typeof raw.linked !== "boolean") return { ok: false, error: "Invalid linked" };
      if (raw.credentialAvailable !== undefined && typeof raw.credentialAvailable !== "boolean") {
        return { ok: false, error: "Invalid credentialAvailable" };
      }
      if (raw.accountLabel !== undefined && typeof raw.accountLabel !== "string") return { ok: false, error: "Invalid accountLabel" };
      let error: { code: string; userMessage: string } | undefined;
      if (raw.error !== undefined) {
        if (!isRecord(raw.error) || typeof raw.error.code !== "string" || typeof raw.error.userMessage !== "string") {
          return { ok: false, error: "Invalid error" };
        }
        error = { code: raw.error.code, userMessage: raw.error.userMessage };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          gatewayOrigin: raw.gatewayOrigin ?? null,
          linked: raw.linked,
          ...(raw.credentialAvailable !== undefined ? { credentialAvailable: raw.credentialAvailable as boolean } : {}),
          ...(raw.accountLabel !== undefined ? { accountLabel: raw.accountLabel } : {}),
          ...(error ? { error } : {}),
        },
      };
    }
    case "POPUP_ACCOUNT_PURCHASE_URL": {
      if (typeof raw.url !== "string" || !raw.url) return { ok: false, error: "Invalid url" };
      return { ok: true, message: { type, requestId, url: raw.url } };
    }
    case "POPUP_AUDIT_EXPORT": {
      if (typeof raw.jsonl !== "string") return { ok: false, error: "Invalid jsonl" };
      if (typeof raw.signatureBase64 !== "string" || !raw.signatureBase64) return { ok: false, error: "Invalid signature" };
      if (!isRecord(raw.publicKeyJwk)) return { ok: false, error: "Invalid publicKeyJwk" };
      if (typeof raw.exportedAt !== "string" || !raw.exportedAt) return { ok: false, error: "Invalid exportedAt" };
      if (typeof raw.eventCount !== "number" || !Number.isInteger(raw.eventCount) || raw.eventCount < 0) {
        return { ok: false, error: "Invalid eventCount" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          jsonl: raw.jsonl,
          signatureBase64: raw.signatureBase64,
          publicKeyJwk: raw.publicKeyJwk,
          exportedAt: raw.exportedAt,
          eventCount: raw.eventCount,
        },
      };
    }
    case "POPUP_API_CONNECT": {
      if (raw.apiUrl !== undefined && typeof raw.apiUrl !== "string") return { ok: false, error: "Invalid apiUrl" };
      if (raw.token !== undefined && typeof raw.token !== "string") return { ok: false, error: "Invalid token" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          apiUrl: raw.apiUrl as string | undefined,
          token: raw.token as string | undefined,
        },
      };
    }
    case "POPUP_API_DISCONNECT":
    case "POPUP_API_GET_STATUS":
    case "POPUP_API_SYNC_POLICY": {
      return { ok: true, message: { type, requestId } };
    }
    case "POPUP_API_SUBMIT_LOGIC": {
      if (typeof raw.patternId !== "string" || !raw.patternId) return { ok: false, error: "Invalid patternId" };
      return { ok: true, message: { type, requestId, patternId: raw.patternId } };
    }
    case "POPUP_OAUTH_CONNECT": {
      return { ok: true, message: { type, requestId } };
    }
    case "POPUP_OAUTH_CALLBACK": {
      if (typeof raw.code !== "string" || !raw.code) return { ok: false, error: "Invalid code" };
      if (typeof raw.state !== "string" || !raw.state) return { ok: false, error: "Invalid state" };
      return { ok: true, message: { type, requestId, code: raw.code, state: raw.state } };
    }
    case "POPUP_OAUTH_STATUS": {
      if (typeof raw.connected !== "boolean") return { ok: false, error: "Invalid connected" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          connected: raw.connected,
          message: typeof raw.message === "string" ? raw.message : undefined,
          tenantId: typeof raw.tenantId === "string" ? raw.tenantId : undefined,
          tenantName: typeof raw.tenantName === "string" ? raw.tenantName : undefined,
          apiUrl: typeof raw.apiUrl === "string" ? raw.apiUrl : undefined,
          capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : undefined,
        },
      };
    }
    case "POPUP_API_STATUS_STATE": {
      if (typeof raw.connectionState !== "string") return { ok: false, error: "Invalid connectionState" };
      if (typeof raw.apiUrl !== "string") return { ok: false, error: "Invalid apiUrl" };
      if (!Array.isArray(raw.capabilities) || !raw.capabilities.every((c) => typeof c === "string")) {
        return { ok: false, error: "Invalid capabilities" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          connectionState: raw.connectionState,
          tenantId: typeof raw.tenantId === "string" ? raw.tenantId : undefined,
          tenantName: typeof raw.tenantName === "string" ? raw.tenantName : undefined,
          apiUrl: raw.apiUrl,
          capabilities: raw.capabilities as string[],
          error: typeof raw.error === "string" ? raw.error : undefined,
        },
      };
    }
    case "POPUP_API_POLICY_STATE": {
      if (typeof raw.success !== "boolean") return { ok: false, error: "Invalid success" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          success: raw.success,
          policyId: typeof raw.policyId === "string" ? raw.policyId : undefined,
          policyVersion: typeof raw.policyVersion === "string" ? raw.policyVersion : undefined,
          rulesCount: typeof raw.rulesCount === "number" ? raw.rulesCount : undefined,
          error: typeof raw.error === "string" ? raw.error : undefined,
        },
      };
    }
    case "POPUP_API_SUBMIT_RESULT": {
      if (typeof raw.success !== "boolean") return { ok: false, error: "Invalid success" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          success: raw.success,
          submissionId: typeof raw.submissionId === "string" ? raw.submissionId : undefined,
          error: typeof raw.error === "string" ? raw.error : undefined,
        },
      };
    }
    case "POPUP_DOC_STATUS": {
      const stage = raw.stage as DocRedactionStage;
      if (stage !== "detected" && stage !== "redacted" && stage !== "verified") return { ok: false, error: "Invalid stage" };
      const method = raw.method as RedactionVerifyMethod | undefined;
      if (method !== undefined && method !== "pixel" && method !== "page-pixels") return { ok: false, error: "Invalid method" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          stage,
          paintedRegions: typeof raw.paintedRegions === "number" ? raw.paintedRegions : undefined,
          verifiedRegions: typeof raw.verifiedRegions === "number" ? raw.verifiedRegions : undefined,
          checkedRegions: typeof raw.checkedRegions === "number" ? raw.checkedRegions : undefined,
          method,
          problem: typeof raw.problem === "string" ? raw.problem : undefined,
        },
      };
    }
    default:
      return { ok: false, error: "Unhandled message type" };
  }
}