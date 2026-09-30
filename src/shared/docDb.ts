// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

/**
 * Staged-document storage shared by the popup and the service worker.
 *
 * Both contexts run on the same extension origin, so they read and write the
 * same database; that is the only reason a file picked in the popup can be
 * picked back up by the worker.
 *
 * This lives in one place on purpose. The popup and the worker previously each
 * carried their own copy of `openDb`, and the copies drifted into a failure
 * mode where the cached connection went stale and every later transaction
 * threw forever, silently disabling the whole extension.
 */

const DB_NAME = "governworld-redaction";
const DB_VERSION = 1;
const STORE = "docfiles";

let dbPromise: Promise<IDBDatabase> | null = null;

const OPEN_TIMEOUT_MS = 5_000;
const OP_TIMEOUT_MS = 10_000;

/**
 * Open (or reuse) the database connection.
 *
 * A cached `IDBDatabase` can stop being usable: another context upgrades the
 * schema, or the browser closes it under pressure. A cached promise keeps
 * handing out that dead connection, and every subsequent transaction throws
 * `InvalidStateError` for the life of the context. Dropping the cache on
 * `close`/`versionchange` is what makes the next call reconnect instead.
 *
 * The open is also bounded, and a `blocked` request fails fast. An
 * `indexedDB.open` blocked by another open connection fires neither `success`
 * nor `error`, so the cached promise would stay pending for the life of the
 * context and every caller would await it forever. That produced the worst
 * symptom in this extension: the popup looked completely inert, with no error
 * anywhere and no console output. Nothing in this module may hang.
 */
export function openDocDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      // Leave the cache clean so the next caller gets a fresh attempt.
      dbPromise = null;
      settle(() => reject(new Error("Local document storage did not respond.")));
    }, OPEN_TIMEOUT_MS);
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      dbPromise = null;
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      settle(() => resolve(db));
    };
    req.onerror = () => {
      dbPromise = null;
      settle(() => reject(req.error ?? new Error("IndexedDB is unavailable")));
    };
    req.onblocked = () => {
      // Another open connection is holding an older version and has not
      // released it. Report it as a retryable failure instead of waiting for
      // an event that will never arrive.
      dbPromise = null;
      settle(() => reject(new Error("Local document storage is busy.")));
    };
  });
  return dbPromise;
}

/** Drop the cached connection so the next operation reconnects. */
export function resetDocDb(): void {
  dbPromise = null;
}

/**
 * Run one write transaction, reconnecting and retrying once, and resolve only
 * once it has committed.
 *
 * The retry covers a dead cached handle: the first attempt throws, the second
 * runs against a fresh connection. The timeout covers a transaction that is
 * created but never completes - a stalled commit must surface as an error, not
 * as a caller that waits forever.
 */
async function commitWrite(commit: (tx: IDBTransaction) => void, label: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openDocDb();
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`Could not ${label}: storage did not respond.`));
        }, OP_TIMEOUT_MS);
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, "readwrite");
        } catch (error) {
          settle(() => reject(error));
          return;
        }
        tx.oncomplete = () => settle(resolve);
        tx.onabort = () => settle(() => reject(tx.error ?? new Error(`Could not ${label}`)));
        tx.onerror = () => settle(() => reject(tx.error ?? new Error(`Could not ${label}`)));
        try {
          commit(tx);
        } catch (error) {
          settle(() => reject(error));
        }
      });
      return;
    } catch (error) {
      lastError = error;
      resetDocDb();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function docStoreFile(fileKey: string, bytes: ArrayBuffer): Promise<void> {
  await commitWrite((tx) => tx.objectStore(STORE).put(bytes, fileKey), "store the file");
}

export async function docDeleteFile(fileKey: string): Promise<void> {
  await commitWrite((tx) => tx.objectStore(STORE).delete(fileKey), "delete the file");
}

export async function docClearFiles(): Promise<void> {
  await commitWrite((tx) => tx.objectStore(STORE).clear(), "clear document files");
}

export async function docReadFile(fileKey: string): Promise<ArrayBuffer | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openDocDb();
    try {
      return await new Promise<ArrayBuffer | null>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("Could not read the file: storage did not respond."));
        }, OP_TIMEOUT_MS);
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, "readonly");
        } catch (error) {
          settle(() => reject(error));
          return;
        }
        const req = tx.objectStore(STORE).get(fileKey);
        req.onsuccess = () => settle(() => resolve((req.result as ArrayBuffer | undefined) ?? null));
        req.onerror = () => settle(() => reject(req.error ?? new Error("Could not read the file")));
        tx.onabort = () => settle(() => reject(tx.error ?? new Error("Could not read the file")));
      });
    } catch (error) {
      lastError = error;
      resetDocDb();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
