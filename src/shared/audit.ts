// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { isRecord } from "./types.js";

/**
 * Metadata-only, tamper-evident audit trail. Every recorded event contains
 * counts, hashes, and policy references — never raw detected values or page
 * content (zero raw-data persistence invariant).
 *
 * Events live in chrome.storage.local (ring buffer). Export produces JSONL
 * plus a detached ECDSA P-256/SHA-256 signature over the exact exported bytes,
 * so a reviewer can verify nothing was altered after the fact.
 */

export const AUDIT_KEY = "auditLog";
export const AUDIT_MAX_EVENTS = 500;

export type AuditAction =
  | "page_scan_completed"
  | "masks_applied"
  | "masks_removed"
  | "doc_previewed"
  | "doc_redacted"
  | "session_cleared"
  | "preset_applied"
  | "preset_overridden"
  | "account_linked";

export interface AuditEvent {
  /** ISO-8601 timestamp. */
  ts: string;
  action: AuditAction;
  /** Host of the scanned page, when applicable (never full URL). */
  host?: string;
  /** Findings surfaced, by category. Counts only. */
  counts?: Record<string, number>;
  /** SHA-256 hex of processed document bytes, when applicable. */
  docHash?: string;
  /** Number of pages processed. */
  pages?: number;
  /** Preset selected by the user (metadata only, never content). */
  presetId?: string;
  /** Gateway origin linked at account_linked time (metadata only, never the key). */
  gatewayOrigin?: string;
  /** Category set active after the change — policy references, never content. */
  enabledCategories?: string[];
  outcome: "ok" | "denied" | "error";
}

function isCounts(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
}

export function isAuditEvent(value: unknown): value is AuditEvent {
  if (!isRecord(value)) return false;
  if (typeof value.ts !== "string" || value.ts.length === 0) return false;
  const actions: AuditAction[] = [
    "page_scan_completed",
    "masks_applied",
    "masks_removed",
    "doc_previewed",
    "doc_redacted",
    "session_cleared",
    "preset_applied",
    "preset_overridden",
    "account_linked",
  ];
  if (!actions.includes(value.action as AuditAction)) return false;
  if (value.outcome !== "ok" && value.outcome !== "denied" && value.outcome !== "error") return false;
  if (value.host !== undefined && (typeof value.host !== "string" || value.host.length === 0 || value.host.length > 253)) return false;
  if (value.counts !== undefined && !isCounts(value.counts)) return false;
  if (value.docHash !== undefined && (typeof value.docHash !== "string" || !/^[a-f0-9]{64}$/.test(value.docHash))) return false;
  if (value.pages !== undefined && (typeof value.pages !== "number" || !Number.isInteger(value.pages) || value.pages < 0)) return false;
  if (value.presetId !== undefined && (typeof value.presetId !== "string" || value.presetId.length === 0 || value.presetId.length > 32)) return false;
  if (
    value.gatewayOrigin !== undefined &&
    (typeof value.gatewayOrigin !== "string" ||
      value.gatewayOrigin.length === 0 ||
      value.gatewayOrigin.length > 2048 ||
      !value.gatewayOrigin.startsWith("https://"))
  )
    return false;
  if (
    value.enabledCategories !== undefined &&
    (!Array.isArray(value.enabledCategories) ||
      value.enabledCategories.some((c) => typeof c !== "string" || c.length === 0 || c.length > 64))
  ) {
    return false;
  }
  return true;
}

/** Canonical serialization: stable key order so signatures are reproducible. */
export function canonicalEventLine(event: AuditEvent): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ["ts", "action", "host", "counts", "docHash", "pages", "presetId", "enabledCategories", "outcome"] as const) {
    if (event[key] !== undefined) ordered[key] = event[key];
  }
  return JSON.stringify(ordered);
}

export function toAuditJsonl(events: AuditEvent[]): string {
  return events.map(canonicalEventLine).join("\n");
}

/** Trim to the newest AUDIT_MAX_EVENTS entries. */
export function trimEvents(events: AuditEvent[]): AuditEvent[] {
  if (events.length <= AUDIT_MAX_EVENTS) return events;
  return events.slice(events.length - AUDIT_MAX_EVENTS);
}

// ---------- Storage (service worker side) ----------

export async function loadAuditLog(): Promise<AuditEvent[]> {
  const raw = await chrome.storage.local.get(AUDIT_KEY);
  const value = raw[AUDIT_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter(isAuditEvent);
}

export async function recordAudit(event: AuditEvent): Promise<void> {
  const events = await loadAuditLog();
  events.push(event);
  await chrome.storage.local.set({ [AUDIT_KEY]: trimEvents(events) });
}

export async function clearAuditLog(): Promise<void> {
  await chrome.storage.local.remove(AUDIT_KEY);
}

// ---------- Signing keys (IndexedDB; non-extractable private key) ----------

const KEY_DB_NAME = "governworld-audit";
const KEY_STORE = "signing-keys";
const KEY_ID = "audit-signing";

let dbPromise: Promise<IDBDatabase> | null = null;

function openKeyDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(KEY_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(KEY_STORE)) req.result.createObjectStore(KEY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB is unavailable"));
  });
  return dbPromise;
}

async function withKeyStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openKeyDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, mode);
    const req = fn(tx.objectStore(KEY_STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? new Error("Key store transaction failed"));
  });
}

export interface AuditSigningKeys {
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

interface StoredSigningKeys {
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

async function getOrCreateSigningKeys(): Promise<AuditSigningKeys> {
  const existing = await withKeyStore<StoredSigningKeys | undefined>("readonly", (s) => s.get(KEY_ID));
  if (existing && existing.privateKey instanceof CryptoKey) {
    return { privateKey: existing.privateKey, publicKeyJwk: existing.publicKeyJwk };
  }
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const stored: StoredSigningKeys = { privateKey: pair.privateKey, publicKeyJwk };
  await withKeyStore("readwrite", (s) => s.put(stored, KEY_ID));
  return { privateKey: pair.privateKey, publicKeyJwk };
}

export interface SignedAuditExport {
  jsonl: string;
  signatureBase64: string;
  publicKeyJwk: JsonWebKey;
  exportedAt: string;
  eventCount: number;
}

/**
 * Export + sign in one step. The signature covers the exact JSONL bytes
 * (UTF-8), so any post-export edit breaks verification.
 */
export async function exportSignedAuditLog(): Promise<SignedAuditExport> {
  const events = await loadAuditLog();
  const jsonl = toAuditJsonl(events);
  const { privateKey, publicKeyJwk } = await getOrCreateSigningKeys();
  const data = new TextEncoder().encode(jsonl);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);
  return {
    jsonl,
    signatureBase64: btoa(String.fromCharCode(...new Uint8Array(signature))),
    publicKeyJwk,
    exportedAt: new Date().toISOString(),
    eventCount: events.length,
  };
}

/** Verify an export against its public key (used by tests and reviewers). */
export async function verifySignedAuditExport(exported: SignedAuditExport): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      exported.publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const data = new TextEncoder().encode(exported.jsonl);
    const sigBytes = Uint8Array.from(atob(exported.signatureBase64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sigBytes, data);
  } catch {
    return false;
  }
}
