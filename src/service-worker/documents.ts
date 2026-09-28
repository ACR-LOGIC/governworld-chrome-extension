// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { DocumentPage } from "../document-pipeline/adapter.js";
import { BrowserDocumentPipeline } from "../document-pipeline/browser.js";
import { MAX_DOC_PAGES } from "../document-pipeline/contract.js";
import type { RedactionVerification } from "../document-pipeline/verify.js";
import type { DocKind, FindingCategory, Rect, RedactionOptions } from "../shared/types.js";
import { loadSettings, meetsThreshold } from "../shared/settings.js";
import { loadCustomPatterns } from "../shared/customPatterns.js";

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

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB is unavailable"));
  });
  return dbPromise;
}

export async function storeFile(fileKey: string, bytes: ArrayBuffer): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(bytes, fileKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not store the file"));
  });
}

export async function readFile(fileKey: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(fileKey);
    req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("Could not read the file"));
  });
}

export async function deleteFile(fileKey: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(fileKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not delete the file"));
  });
}

export async function clearAllFiles(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not clear document files"));
  });
  await chrome.storage.session.remove(LAST_DOC_KEY);
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

export function getSession(docId: string): DocSession | null {
  return sessions.get(docId) ?? null;
}

export function getLastSession(): DocSession | null {
  return lastDocId ? sessions.get(lastDocId) ?? null : null;
}

export async function clearSession(docId: string): Promise<void> {
  const session = sessions.get(docId);
  if (session) await deleteFile(session.fileKey);
  sessions.delete(docId);
  if (lastDocId === docId) setLastDocId(null);
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
): Promise<{ outputName: string; outputBytes: Uint8Array; outputMimeType: string; verification: RedactionVerification; redactedRegions: number }> {
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
    redactedRegions: targetBoxes.reduce((n, b) => n + b.rects.length, 0)
  };
}