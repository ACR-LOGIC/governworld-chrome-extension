// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { DocumentPage } from "../document-pipeline/adapter.js";
import { BrowserDocumentPipeline } from "../document-pipeline/browser.js";
import { MAX_DOC_PAGES } from "../document-pipeline/contract.js";
import type { RedactionVerification } from "../document-pipeline/verify.js";
import type { RedactedDocRef } from "../shared/docStore.js";
import type { DocKind, FindingCategory, Rect, RedactionOptions } from "../shared/types.js";
import { loadSettings, meetsThreshold } from "../shared/settings.js";
import {
  DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE,
  isDocumentPipelineSupported,
} from "../shared/platform.js";
import { loadCustomPatterns } from "../shared/customPatterns.js";
import { docStoreFile, docReadFile, docDeleteFile, docClearFiles } from "../shared/docDb.js";

/**
 * Document session management for the service worker. File bytes are held in
 * IndexedDB (shared with the popup) so they survive popup reloads; the
 * in-memory session only holds metadata + preview pages. Raw page text is
 * never stored — only masked previews and rectangles.
 */

const DB_NAME = "governworld-redaction";
const DB_VERSION = 1;
const STORE = "docfiles";
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const LAST_DOC_KEY = "lastDocId";
/**
 * Descriptor for the in-flight/last document session, minus the file bytes.
 *
 * MV3 tears the service worker down after ~30s idle and the `sessions` map dies
 * with it, while `lastDocId` in storage.session survives. That combination made
 * the Document Studio vanish on reopen even though the bytes were still in
 * IndexedDB, so a user who looked away during the 6-20s preview lost the whole
 * job. Persisting the descriptor lets the worker rebuild the session from the
 * stored file instead of asking the user to pick the document again.
 */
const LAST_SESSION_KEY = "lastDocSession";

export interface DocSession {
  docId: string;
  fileKey: string;
  name: string;
  mimeType: string;
  kind: DocKind;
  bytes: ArrayBuffer;
  pages: DocumentPage[];
  categories: FindingCategory[];
}

const sessions = new Map<string, DocSession>();
let lastDocId: string | null = null;

export async function storeFile(fileKey: string, bytes: ArrayBuffer): Promise<void> {
  await docStoreFile(fileKey, bytes);
}

export async function readFile(fileKey: string): Promise<ArrayBuffer | null> {
  return docReadFile(fileKey);
}

export async function deleteFile(fileKey: string): Promise<void> {
  await docDeleteFile(fileKey);
}

export async function clearAllFiles(): Promise<void> {
  await docClearFiles();
  await chrome.storage.session.remove(LAST_DOC_KEY);
  forgetPersistedSession();
  sessions.clear();
  lastDocId = null;
}

export async function loadLastDocId(): Promise<string | null> {
  const raw = await chrome.storage.session.get(LAST_DOC_KEY);
  const value = raw[LAST_DOC_KEY];
  return typeof value === "string" && value ? value : null;
}

function setLastDocId(docId: string | null): void {
  lastDocId = docId;
  void chrome.storage.session.set({ [LAST_DOC_KEY]: docId }).catch(() => undefined);
}

interface PersistedSession {
  docId: string;
  fileKey: string;
  name: string;
  mimeType: string;
  kind: DocKind;
  pages: DocumentPage[];
  categories: FindingCategory[];
}

/** Record enough to rebuild the session after the worker is recycled. */
function persistSession(session: DocSession): void {
  const record: PersistedSession = {
    docId: session.docId,
    fileKey: session.fileKey,
    name: session.name,
    mimeType: session.mimeType,
    kind: session.kind,
    pages: session.pages,
    categories: session.categories,
  };
  void chrome.storage.session.set({ [LAST_SESSION_KEY]: record }).catch(() => undefined);
}

function forgetPersistedSession(): void {
  void chrome.storage.session.remove(LAST_SESSION_KEY).catch(() => undefined);
}

export function getSession(docId: string): DocSession | null {
  return sessions.get(docId) ?? null;
}

export function getLastSession(): DocSession | null {
  return lastDocId ? sessions.get(lastDocId) ?? null : null;
}

/**
 * Return the last document session, rebuilding it from IndexedDB if the worker
 * was recycled. Returns null when there is nothing to restore or the file the
 * descriptor points at is gone.
 */
export async function restoreLastSession(): Promise<DocSession | null> {
  const live = getLastSession();
  if (live) return live;

  const raw = await chrome.storage.session.get(LAST_SESSION_KEY).catch(() => ({} as Record<string, unknown>));
  const record = raw[LAST_SESSION_KEY] as PersistedSession | undefined;
  if (!record || typeof record.docId !== "string" || typeof record.fileKey !== "string" || !Array.isArray(record.pages)) {
    return null;
  }

  // The descriptor can outlive its file (cleared, or the browser evicted it).
  const bytes = await readFile(record.fileKey).catch(() => null);
  if (!bytes) {
    forgetPersistedSession();
    return null;
  }

  const session: DocSession = {
    docId: record.docId,
    fileKey: record.fileKey,
    name: record.name,
    mimeType: record.mimeType,
    kind: record.kind,
    bytes,
    pages: record.pages,
    categories: Array.isArray(record.categories) ? record.categories : uniqueCategories(record.pages),
  };
  sessions.set(session.docId, session);
  setLastDocId(session.docId);
  return session;
}

export async function clearSession(docId: string): Promise<void> {
  const session = sessions.get(docId);
  if (session) await deleteFile(session.fileKey);
  sessions.delete(docId);
  if (lastDocId === docId) {
    setLastDocId(null);
    forgetPersistedSession();
  }
}

const pipeline = new BrowserDocumentPipeline();

function uniqueCategories(pages: DocumentPage[]): FindingCategory[] {
  const seen = new Set<FindingCategory>();
  for (const page of pages) for (const f of page.findings) seen.add(f.category);
  return [...seen];
}

export async function previewDocument(
  fileKey: string,
  name: string,
  mimeType: string,
  kind: DocKind
): Promise<{ docId: string; pages: DocumentPage[] }> {
  // The pipeline runs in an offscreen document (Chromium-only). On browsers
  // without it, say so plainly instead of failing deep in the job queue.
  if (!isDocumentPipelineSupported()) throw new Error(DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE);
  const bytes = await readFile(fileKey);
  if (!bytes) throw new Error("The selected file is no longer available. Please re-open it.");
  if (bytes.byteLength > MAX_DOC_BYTES) throw new Error("Document is too large to process on this device.");

  const settings = await loadSettings();
  const customPatterns = await loadCustomPatterns();
  const docId = crypto.randomUUID();
  let rawPages: DocumentPage[];
  try {
    await clearAllFiles();
    await storeFile(fileKey, bytes);
    rawPages = await pipeline.preview({
      kind,
      bytes,
      name,
      mimeType,
      enabledCategories: settings.enabledCategories,
      maxPages: MAX_DOC_PAGES,
      padding: settings.maskPadding,
      previewPages: [],
      categories: [],
      ocrLanguage: settings.ocrLanguage,
      customPatterns,
      previewKeyPrefix: fileKey,
    });
  } catch (error) {
    await deleteFile(fileKey).catch(() => undefined);
    throw error;
  }
  // Confidence thresholds are enforced server-side (here), not in the UI.
  const pages = rawPages.map((p) => ({
    ...p,
    findings: p.findings.filter((f) => meetsThreshold(settings, f.category, f.confidence)),
  }));

  sessions.set(docId, { docId, fileKey, name, mimeType, kind, bytes, pages, categories: uniqueCategories(pages) });
  setLastDocId(docId);
  persistSession(sessions.get(docId)!);
  return { docId, pages };
}

export async function redactDocument(
  docId: string,
  fileKey: string,
  name: string,
  mimeType: string,
  kind: DocKind,
  boxes: { pageIndex: number; rects: Rect[] }[],
  findingIds: string[],
  options?: RedactionOptions
): Promise<{ outputName: string; outputBytes: Uint8Array; outputMimeType: string; verification: RedactionVerification; redactedRegions: number; printRef: RedactedDocRef | null }> {
  const session = sessions.get(docId);
  if (!session || session.fileKey !== fileKey || session.kind !== kind || session.name !== name) {
    throw new Error("This document is no longer loaded. Please re-open it.");
  }
  const settings = await loadSettings();
  const selectedIds = new Set(findingIds);
  if (selectedIds.size === 0 || selectedIds.size !== findingIds.length) {
    if (!boxes || boxes.length === 0) {
      throw new Error("Select at least one finding to redact.");
    }
  }
  const availableIds = new Set(session.pages.flatMap((page) => page.findings.map((finding) => finding.id)));
  if ([...selectedIds].some((id) => !availableIds.has(id) && !id.startsWith("custom:") && !id.startsWith("user:"))) {
    throw new Error("The selected findings are no longer available.");
  }

  // If explicit boxes (including custom drawn boxes) are provided, use them;
  // otherwise derive from selected session findings.
  const explicitBoxes = (boxes ?? []).filter((b) => b.rects && b.rects.length > 0);
  const derivedBoxes = session.pages
    .map((page) => ({
      pageIndex: page.index,
      rects: page.findings.filter((finding) => selectedIds.has(finding.id)).flatMap((finding) => finding.rects),
    }))
    .filter((page) => page.rects.length > 0);

  const targetBoxes = explicitBoxes.length > 0 ? explicitBoxes : derivedBoxes;
  if (targetBoxes.length === 0) {
    throw new Error("The selected findings have no redactable regions.");
  }

  const effectivePadding = options?.padding ?? settings.maskPadding;
  const result = await pipeline.redact(
    {
      kind: session.kind,
      bytes: session.bytes,
      name: session.name,
      mimeType: session.mimeType,
      enabledCategories: settings.enabledCategories,
      maxPages: MAX_DOC_PAGES,
      padding: effectivePadding,
      previewKeyPrefix: session.fileKey,
      previewPages: session.pages,
      categories: session.categories,
      options,
    },
    targetBoxes,
    options
  );
  return {
    outputName: result.outputName,
    outputBytes: result.outputBytes,
    outputMimeType: result.outputMimeType,
    verification: result.verification,
    redactedRegions: targetBoxes.reduce((n, b) => n + b.rects.length, 0),
    printRef: result.printRef ?? null
  };
}