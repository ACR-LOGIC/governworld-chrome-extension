// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { MAX_MESSAGE_BYTES } from "./types.js";

/**
 * Shared IndexedDB handle for document bytes and rendered page previews.
 *
 * Preview images used to travel inside the POPUP_DOC_STATE runtime message as
 * base64 data URLs. Every message is bounded by MAX_MESSAGE_BYTES (64 KB), and a
 * single 1240x1754 page preview is several megabytes, so `validateMessage`
 * rejected the message with "Message exceeds size limit" and the popup dropped it
 * silently — the Document Studio could never open. Previews are persisted here
 * and referenced by a short key instead, which keeps the message small and leaves
 * the size guard doing its job.
 *
 * The database and store are shared with the service worker so staged files
 * survive popup reloads; this module is the single place that knows the layout.
 */

export const DB_NAME = "governworld-redaction";
export const DB_VERSION = 1;
export const STORE = "docfiles";

/** Keys are derived from a validated fileKey, so the shape is known. */
export const PREVIEW_KEY_RE = /^[A-Za-z0-9_-]{1,64}::preview::\d{1,4}$/;

export function previewKey(fileKey: string, pageIndex: number): string {
  return `${fileKey}::preview::${pageIndex}`;
}

export function isPreviewKey(value: unknown): value is string {
  return typeof value === "string" && PREVIEW_KEY_RE.test(value);
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDocDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB is unavailable"));
  });
  // A failed open must not poison every later call.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

export async function putDocBytes(key: string, bytes: ArrayBuffer): Promise<void> {
  const db = await openDocDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(bytes, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not store the document bytes"));
  });
}

export async function getDocBytes(key: string): Promise<ArrayBuffer | null> {
  const db = await openDocDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("Could not read the document bytes"));
  });
}

export async function deleteDocBytes(key: string): Promise<void> {
  const db = await openDocDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not delete the document bytes"));
  });
}

/** Resolve a stored preview into an object URL suitable for `<img src>`. */
export async function previewObjectUrl(key: string): Promise<string | null> {
  const bytes = await getDocBytes(key);
  if (!bytes || bytes.byteLength === 0) return null;
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

export { MAX_MESSAGE_BYTES };
