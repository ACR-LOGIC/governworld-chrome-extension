// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { validateMessage } from "../shared/messages.js";
import { loadSettings, saveSettings, isCloudAllowed, isAllowedGatewayOrigin, meetsThreshold } from "../shared/settings.js";
import { recordAudit, exportSignedAuditLog } from "../shared/audit.js";
import type { Settings } from "../shared/settings.js";
import type { DocKind, PopupState, ScanMode, WorkerMessage, ExtensionMessage, Finding, PopupFromWorker, Rect } from "../shared/types.js";
import { previewDocument, redactDocument, getLastSession, clearSession as clearDocSession, clearAllFiles } from "./documents.js";
import { analyzeExamples, testPattern } from "../shared/wizardAnalyzer.js";
import {
  loadCustomPatterns,
  saveCustomPattern,
  deleteCustomPattern,
  loadCommunityAccount,
  unlinkCommunityAccount,
  saveCommunityAccount,
} from "../shared/customPatterns.js";

/**
 * Extension service worker (MV3). Permission-aware orchestration: owns all
 * network requests (none in local mode), enforces consent gating, injects the
 * content script only after a deliberate user action, and validates every
 * message from popup/content scripts before acting on it.
 */

const SESSION_KEY_PREFIX = "scan:";
const SCAN_TIMEOUT_MS = 60_000;

interface SessionState {
  sessionId: string;
  mode: ScanMode;
  findings: Finding[];
  stats: { visibleChars: number; truncated: boolean };
  scannedAt: number;
  /** Stack of previously-applied finding-id sets for undo. Newest last. */
  maskHistory?: string[][];
}

const MAX_MASK_HISTORY = 10;

function pushMaskHistory(state: SessionState, appliedIds: string[]): SessionState {
  const history = [...(state.maskHistory ?? []), appliedIds];
  return { ...state, maskHistory: history.slice(-MAX_MASK_HISTORY) };
}

const pendingScans = new Map<number, { requestId: string; sessionId: string; timer: ReturnType<typeof setTimeout> }>();

function sessionKey(tabId: number): string {
  return `${SESSION_KEY_PREFIX}${tabId}`;
}

async function readSession(tabId: number): Promise<SessionState | null> {
  const raw = await chrome.storage.session.get(sessionKey(tabId));
  const value = raw[sessionKey(tabId)];
  return value ?? null;
}

async function writeSession(tabId: number, state: SessionState): Promise<void> {
  await chrome.storage.session.set({ [sessionKey(tabId)]: state });
}

async function clearSession(tabId: number): Promise<void> {
  await chrome.storage.session.remove(sessionKey(tabId));
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function notifyPopup(message: PopupFromWorker): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    // Popup may be closed; state lives in storage.session for the next open.
  });
}

/**
 * Base64-encode bytes without blowing the argument limit.
 *
 * `String.fromCharCode(...bytes)` throws "Maximum call stack size exceeded" on
 * anything but small inputs, and a 24-megapixel image is far past that. The
 * buffer is walked in chunks instead.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (error) {
    // `activeTab` may not cover the tab if invoked without a user gesture.
    throw new Error(`Unable to inject content script on tab ${tabId}: ${String(error)}`);
  }
}

async function sendToTab(tabId: number, message: unknown): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content script may have been destroyed by navigation; inject once and retry.
    await ensureContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

/** A mask command succeeded only when the content script explicitly said so. */
function maskCommandOk(response: unknown): boolean {
  return response === undefined || (typeof response === "object" && response !== null && (response as { ok?: boolean }).ok !== false);
}

function buildPopupState(
  settings: Settings,
  session: SessionState | null,
  error?: { code: string; userMessage: string }
): PopupState {
  return {
    mode: settings.mode,
    scanning: false,
    findings: session?.findings ?? [],
    scanned: session !== null,
    truncated: session?.stats.truncated ?? false,
    visibleChars: session?.stats.visibleChars ?? 0,
    error,
    consentRequired: settings.mode === "cloud" && !isCloudAllowed(settings),
    sessionId: session?.sessionId,
  };
}

async function stateForActiveTab(): Promise<PopupState> {
  const settings = await loadSettings();
  const tab = await getActiveTab();
  const session = tab ? await readSession(tab.id ?? -1) : null;
  return buildPopupState(settings, session);
}

async function handlePopupScan(mode: ScanMode, requestId: string): Promise<void> {
  const settings = await loadSettings();

  if (mode === "cloud" && !isCloudAllowed(settings)) {
    notifyPopup({
      type: "POPUP_STATE",
      requestId,
      state: buildPopupState(settings, null, {
        code: "CLOUD_NOT_ALLOWED",
        userMessage: "Cloud analysis is disabled. Scans run locally on this device.",
      }),
    });
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id) {
    notifyPopup({
      type: "POPUP_STATE",
      requestId,
      state: buildPopupState(settings, null, {
        code: "NO_ACTIVE_TAB",
        userMessage: "No active tab to scan.",
      }),
    });
    return;
  }

  const sessionId = crypto.randomUUID();
  const tabId = tab.id;
  const timer = setTimeout(() => {
    pendingScans.delete(tabId);
    void (async () => {
      const session = await readSession(tabId);
      notifyPopup({
        type: "POPUP_STATE",
        requestId,
        state: buildPopupState(settings, session, {
          code: "SCAN_TIMEOUT",
          userMessage: "Scan timed out. Try again.",
        }),
      });
    })().catch(() => undefined);
  }, SCAN_TIMEOUT_MS);
  pendingScans.set(tab.id, { requestId, sessionId, timer });

  await writeSession(tab.id, { sessionId, mode, findings: [], stats: { visibleChars: 0, truncated: false }, scannedAt: Date.now() });

  const message: WorkerMessage = {
    type: "SCAN_PAGE",
    requestId,
    mode,
    sessionId,
    settings: {
      enabledCategories: settings.enabledCategories,
      maxVisibleChars: settings.maxVisibleChars,
      maxNodeChars: settings.maxNodeChars,
      maskPlaceholders: settings.maskPlaceholders,
    },
  };
  await sendToTab(tab.id, message);
}

async function handlePopupApplyMasks(findingIds: string[], requestId: string): Promise<void> {
  const tab = await getActiveTab();
  const settings = await loadSettings();
  const session = tab?.id ? await readSession(tab.id) : null;
  if (!tab?.id || !session) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "NO_SESSION", userMessage: "Run a scan first." }) });
    return;
  }
  const response = await sendToTab(tab.id, { type: "APPLY_MASKS", requestId, sessionId: session.sessionId, findingIds });
  if (!maskCommandOk(response)) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "STALE_SESSION", userMessage: "This scan session is no longer active. Run a scan again." }) });
    return;
  }
  const idSet = new Set(findingIds);
  const withHistory = pushMaskHistory(session, findingIds);
  const updated: SessionState = { ...withHistory, findings: withHistory.findings.map((f) => ({ ...f, selected: idSet.has(f.id) })) };
  await writeSession(tab.id, updated);
  void recordAudit({
    ts: new Date().toISOString(),
    action: "masks_applied",
    counts: countByCategory(updated.findings.filter((f) => idSet.has(f.id))),
    outcome: "ok",
  });
  notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, updated) });
}

async function handlePopupUndoMasks(requestId: string): Promise<void> {
  const tab = await getActiveTab();
  const settings = await loadSettings();
  const session = tab?.id ? await readSession(tab.id) : null;
  if (!tab?.id || !session || !session.maskHistory || session.maskHistory.length === 0) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "NO_HISTORY", userMessage: "Nothing to undo." }) });
    return;
  }
  const history = [...session.maskHistory];
  const previousIds = history.pop() as string[];
  const undoResponse = await sendToTab(tab.id, { type: "APPLY_MASKS", requestId, sessionId: session.sessionId, findingIds: previousIds });
  if (!maskCommandOk(undoResponse)) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "STALE_SESSION", userMessage: "This scan session is no longer active. Run a scan again." }) });
    return;
  }
  const idSet = new Set(previousIds);
  const updated: SessionState = { ...session, maskHistory: history, findings: session.findings.map((f) => ({ ...f, selected: idSet.has(f.id) })) };
  await writeSession(tab.id, updated);
  notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, updated) });
}

async function handlePopupRemoveMasks(requestId: string): Promise<void> {
  const tab = await getActiveTab();
  const settings = await loadSettings();
  const session = tab?.id ? await readSession(tab.id) : null;
  if (!tab?.id || !session) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "NO_SESSION", userMessage: "Run a scan first." }) });
    return;
  }
  const removeResponse = await sendToTab(tab.id, { type: "REMOVE_MASKS", requestId, sessionId: session.sessionId });
  if (!maskCommandOk(removeResponse)) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "STALE_SESSION", userMessage: "This scan session is no longer active. Run a scan again." }) });
    return;
  }
  const updated: SessionState = { ...session, findings: session.findings.map((f) => ({ ...f, selected: false })) };
  await writeSession(tab.id, updated);
  void recordAudit({ ts: new Date().toISOString(), action: "masks_removed", outcome: "ok" });
  notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, updated) });
}

async function handlePopupCopyRedacted(findingIds: string[], requestId: string): Promise<void> {
  const tab = await getActiveTab();
  const session = tab?.id ? await readSession(tab.id) : null;
  if (!tab?.id || !session) {
    const settings = await loadSettings();
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "NO_SESSION", userMessage: "Run a scan first." }) });
    return;
  }
  await sendToTab(tab.id, { type: "COPY_REDACTED_TEXT", requestId, sessionId: session.sessionId, findingIds });
}

async function handlePopupClearData(requestId: string): Promise<void> {
  const tab = await getActiveTab();
  const settings = await loadSettings();
  if (tab?.id) {
    const session = await readSession(tab.id);
    if (session) {
      await sendToTab(tab.id, { type: "REMOVE_MASKS", requestId, sessionId: session.sessionId });
      await clearSession(tab.id);
    }
  }
  await clearAllFiles();
  const cleared: Settings = { ...settings, disclosureAcknowledged: false };
  await saveSettings(cleared);
  void recordAudit({ ts: new Date().toISOString(), action: "session_cleared", outcome: "ok" });
  notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(cleared, null) });
}

async function handlePopupSetMode(mode: ScanMode, requestId: string): Promise<void> {
  const settings = await loadSettings();
  if (mode === "cloud" && !isCloudAllowed(settings)) {
    // No gateway deployment exists. Fail closed: never allow a cloud mode that
    // could imply network transmission. The seam stays deny-by-default.
    notifyPopup({
      type: "POPUP_STATE",
      requestId,
      state: buildPopupState(settings, null, {
        code: "CLOUD_NOT_ALLOWED",
        userMessage: "Cloud analysis is unavailable until a gateway is deployed and enabled.",
      }),
    });
    return;
  }
  settings.mode = mode;
  await saveSettings(settings);
  const tab = await getActiveTab();
  const session = tab?.id ? await readSession(tab.id) : null;
  notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session) });
}

async function handlePopupDocPreview(
  fileKey: string,
  name: string,
  mimeType: string,
  kind: DocKind,
  requestId: string
): Promise<void> {
  try {
    const { docId, pages } = await previewDocument(fileKey, name, mimeType, kind);
    notifyPopup({ type: "POPUP_DOC_STATE", requestId, docId, name, fileKey, mimeType, kind, pages });
    void recordAudit({
      ts: new Date().toISOString(),
      action: "doc_previewed",
      counts: countByCategory(pages.flatMap((p) => p.findings)),
      pages: pages.length,
      outcome: "ok",
    });
  } catch (error) {
    const userMessage = error instanceof Error ? error.message : "The document could not be processed.";
    notifyPopup({ type: "POPUP_DOC_ERROR", requestId, code: "DOC_ERROR", userMessage });
    void recordAudit({ ts: new Date().toISOString(), action: "doc_previewed", outcome: "error" });
  }
}

/**
 * Redaction audit records whose delivery outcome the popup still owes us.
 *
 * The audit chain has to describe what happened to the USER'S FILE, not what
 * happened inside the worker. When the worker's own `chrome.downloads` call
 * fails and the popup takes over the download, only the popup knows whether the
 * file arrived - so the record is deferred until the popup reports back, and a
 * missing report is recorded as a failure rather than assumed successful.
 */
interface PendingDeliveryAudit {
  requestId: string;
  docHash: string;
  timer: ReturnType<typeof setTimeout>;
}

const pendingDeliveryAudits = new Map<string, PendingDeliveryAudit>();

/** How long to wait for the popup's delivery report before failing closed. */
const DELIVERY_REPORT_TIMEOUT_MS = 60_000;

async function settleDeliveryAudit(requestId: string, delivered: boolean): Promise<void> {
  const pending = pendingDeliveryAudits.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingDeliveryAudits.delete(requestId);
  await recordAudit({
    ts: new Date().toISOString(),
    action: "doc_redacted",
    docHash: pending.docHash,
    outcome: delivered ? "ok" : "error",
  });
}

function deferDeliveryAudit(requestId: string, docHash: string): void {
  const timer = setTimeout(() => {
    // No report arrived, so delivery is unconfirmed. Fail closed: an unverified
    // delivery must never be written into the chain as a success.
    void settleDeliveryAudit(requestId, false);
  }, DELIVERY_REPORT_TIMEOUT_MS);
  pendingDeliveryAudits.set(requestId, { requestId, docHash, timer });
}

async function handlePopupDocRedact(
  docId: string,
  fileKey: string,
  name: string,
  mimeType: string,
  kind: DocKind,
  boxes: { pageIndex: number; rects: Rect[] }[],
  findingIds: string[],
  requestId: string
): Promise<void> {
  try {
    const { outputName, outputBytes, outputMimeType, verification, redactedRegions } = await redactDocument(
      docId,
      fileKey,
      name,
      mimeType,
      kind,
      boxes,
      findingIds
    );
    const docHash = await sha256Hex(outputBytes);

    // REDACTED: an artifact exists with boxes painted. This is a claim about
    // work performed, and it is reported as its own stage precisely because it
    // is weaker than what follows.
    notifyPopup({ type: "POPUP_DOC_STATUS", requestId, stage: "redacted", paintedRegions: redactedRegions });

    // VERIFIED: the output was re-read and the boxes confirmed covered. If the
    // check failed the user is told so here rather than being handed a file that
    // still shows the value, because a failed verification is the only signal
    // they would otherwise never see.
    notifyPopup({
      type: "POPUP_DOC_STATUS",
      requestId,
      stage: "verified",
      verifiedRegions: verification.darkRegions,
      checkedRegions: verification.checkedRegions,
      method: verification.method,
      ...(verification.verified ? {} : { problem: verification.failures[0] ?? "Output could not be verified." })
    });

    // Primary: service-worker download (fast, saveAs picker). Fallback: send bytes to popup for anchor download
    // so file outputs are always produced even if chrome.downloads is unavailable or the blob URL is revoked.
    //
    // A service worker has no URL.createObjectURL - it is not part of the
    // ServiceWorkerGlobalScope. Calling it threw a TypeError on every single
    // document redaction, so this primary path never once succeeded and every
    // redaction silently degraded to the popup fallback. chrome.downloads
    // accepts a data: URL, which needs no object URL, so the primary path works
    // from the worker again.
    let downloadOk = false;
    try {
      const dataUrl = `data:${outputMimeType};base64,${bytesToBase64(outputBytes)}`;
      await chrome.downloads.download({ url: dataUrl, filename: outputName, saveAs: true });
      downloadOk = true;
    } catch (error) {
      // Falling back to the popup is correct, but swallowing the reason makes a
      // delivery failure undiagnosable in the field: every incident looks
      // identical to a successful redaction. Record it, minus any payload bytes.
      console.warn("[governworld] service-worker download failed, using popup fallback:", error);
      downloadOk = false;
    }

    await clearDocSession(docId);
    // Only ship the bytes over the message port when the service-worker
    // download actually failed. Sending them unconditionally produced the file
    // twice on the happy path and pushed a full document through the extension
    // messaging channel for no reason.
    if (downloadOk) {
      // The browser accepted the file, so the outcome is known here. Recording
      // "ok" unconditionally would still be wrong, but this path genuinely
      // succeeded.
      void recordAudit({ ts: new Date().toISOString(), action: "doc_redacted", docHash, outcome: "ok" });
      notifyPopup({ type: "POPUP_DOC_DONE", requestId, outputName, outputMimeType });
    } else {
      // The worker cannot know whether the popup's fallback download reached the
      // user, so it must not decide the audit outcome. Wait for the report.
      deferDeliveryAudit(requestId, docHash);
      notifyPopup({
        type: "POPUP_DOC_DONE",
        requestId,
        outputName,
        outputBytesBase64: bytesToBase64(outputBytes),
        outputMimeType,
      });
    }
  } catch (error) {
    const userMessage = error instanceof Error ? error.message : "The document could not be redacted.";
    notifyPopup({ type: "POPUP_DOC_STATUS", requestId, stage: "verified", problem: userMessage });
    notifyPopup({ type: "POPUP_DOC_ERROR", requestId, code: "DOC_ERROR", userMessage });
    void recordAudit({ ts: new Date().toISOString(), action: "doc_redacted", outcome: "error" });
  }
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function countByCategory(findings: { category: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.category] = (counts[f.category] ?? 0) + 1;
  return counts;
}

/**
 * Host of the scanned tab for the audit record, or undefined when Chrome
 * withheld the URL.
 *
 * `tab.url` is readable WITHOUT the broad `tabs` permission: the `activeTab`
 * grant (popup click or `Alt+Shift+S` command) already exposes sensitive tab
 * properties for that tab, so the extension deliberately never requests
 * `tabs` (see PERMISSIONS.md and tests/manifest.test.ts). The grant lapses on
 * navigation or browser restart, which is why this may legitimately yield
 * undefined — that degrades the audit record's `host` field to "not available"
 * and must never abort the scan, so URL parsing is guarded.
 */
function tabHost(tab: chrome.tabs.Tab | undefined): string | undefined {
  if (!tab?.url) return undefined;
  try {
    return new URL(tab.url).host || undefined;
  } catch {
    return undefined;
  }
}

async function handleContentScanResult(message: Extract<WorkerMessage, { type: "SCAN_RESULT" }>, tabId: number): Promise<void> {
  const pending = pendingScans.get(tabId);
  // Bind the result to the scan that produced it. A stale or mismatched result
  // is dropped fail-closed: never persisted, never surfaced as a success.
  if (pending) {
    if (message.sessionId !== pending.sessionId) {
      clearTimeout(pending.timer);
      pendingScans.delete(tabId);
      return;
    }
    clearTimeout(pending.timer);
    pendingScans.delete(tabId);
  }
  const settings = await loadSettings();
  const findings = message.findings.filter((f) => meetsThreshold(settings, f.category, f.confidence));
  await writeSession(tabId, {
    sessionId: message.sessionId,
    mode: settings.mode,
    findings,
    stats: message.stats,
    scannedAt: Date.now(),
  });
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  void recordAudit({
    ts: new Date().toISOString(),
    action: "page_scan_completed",
    host: tabHost(tab),
    counts: countByCategory(findings),
    outcome: "ok",
  });
  const session = await readSession(tabId);
  notifyPopup({ type: "POPUP_STATE", requestId: pending?.requestId ?? "state", state: buildPopupState(settings, session) });
  void maybeNotifyFindings(findings);
}

async function handleContentCopyResult(message: Extract<WorkerMessage, { type: "COPY_REDACTED_TEXT_RESULT" }>, _tabId: number): Promise<void> {
  notifyPopup({ type: "POPUP_COPY_RESULT", requestId: message.requestId, text: message.text });
}

async function handleContentError(message: Extract<WorkerMessage, { type: "CONTENT_ERROR" }>, tabId: number): Promise<void> {
  const pending = pendingScans.get(tabId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingScans.delete(tabId);
  }
  const settings = await loadSettings();
  const session = await readSession(tabId);
  notifyPopup({
    type: "POPUP_STATE",
    requestId: pending?.requestId ?? "state",
    state: buildPopupState(settings, session, { code: message.code, userMessage: message.userMessage }),
  });
}

// ---------- Notifications (optional permission) ----------

/** True when the user has granted the optional notifications permission. */
async function notificationsGranted(): Promise<boolean> {
  return (await chrome.permissions.contains({ permissions: ["notifications"] })) as boolean;
}

/**
 * Surface a scan finding as a Chrome notification. Fail-closed: only fires when
 * the user enabled notifications in settings AND granted the optional
 * permission AND at least one finding was detected.
 */
async function maybeNotifyFindings(findings: Finding[]): Promise<void> {
  if (findings.length === 0) return;
  const settings = await loadSettings();
  if (!settings.notificationsEnabled) return;
  if (!(await notificationsGranted())) return;
  const counts = countByCategory(findings);
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([category, n]) => `${n} ${category.replace(/_/g, " ")}`)
    .join(", ");  await chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: "GovernWorld — sensitive data found",
    message: `${findings.length} value${findings.length === 1 ? "" : "s"} detected on this page: ${top}.`,
    priority: 0,
  });
}

// ---------- Account (gateway identity binding) ----------

/**
 * The user-pasted `gw_*` API key is a long-lived bearer credential. It is
 * NEVER written to chrome.storage.local (unencrypted, persistent at rest, and
 * readable by any extension context). It is kept only in chrome.storage.session
 * (in-memory, cleared when the browser session ends) under ACCOUNT_KEY_CREDENTIAL.
 * chrome.storage.local stores only non-secret metadata (gateway origin, linked
 * flag, account label).
 *
 * Consequence: on a fresh browser start the account stays "linked" (metadata
 * survives) but the credential is absent until the user re-enters the key.
 * Privileged flows read the key lazily from session on every use and fail
 * closed with a clear re-entry message when it is missing — they never fall
 * back to any stored key, because none is ever persisted.
 */
const ACCOUNT_KEY = "account";
const ACCOUNT_KEY_CREDENTIAL = "accountApiKey";

/** Non-secret account metadata persisted in chrome.storage.local. */
interface StoredAccount {
  gatewayOrigin: string;
  linked: boolean;
  accountLabel?: string;
}

/** Account link status (metadata) + live-credential availability (session). */
interface AccountState {
  /** Metadata present in chrome.storage.local — survives browser restarts. */
  linked: boolean;
  gatewayOrigin: string | null;
  accountLabel?: string;
  /** A live credential is present in chrome.storage.session this browser session. */
  credentialAvailable: boolean;
}

async function readAccountMetadata(): Promise<StoredAccount | null> {
  const raw = await chrome.storage.local.get(ACCOUNT_KEY);
  const account = raw[ACCOUNT_KEY] as StoredAccount | undefined;
  return account?.linked ? account : null;
}

/** The live API key, read lazily from chrome.storage.session on every use. */
async function readAccountCredential(): Promise<string | null> {
  const raw = await chrome.storage.session.get(ACCOUNT_KEY_CREDENTIAL);
  const key = raw[ACCOUNT_KEY_CREDENTIAL];
  return typeof key === "string" && key.length > 0 ? key : null;
}

async function readAccount(): Promise<AccountState> {
  const [metadata, credential] = await Promise.all([readAccountMetadata(), readAccountCredential()]);
  return {
    linked: metadata !== null,
    gatewayOrigin: metadata?.gatewayOrigin ?? null,
    accountLabel: metadata?.accountLabel,
    credentialAvailable: credential !== null,
  };
}

async function notifyAccountState(requestId: string, error?: { code: string; userMessage: string }): Promise<void> {
  const settings = await loadSettings();
  const account = await readAccount();
  notifyPopup({
    type: "POPUP_ACCOUNT_STATE",
    requestId,
    gatewayOrigin: settings.gatewayOrigin,
    linked: account.linked,
    credentialAvailable: account.credentialAvailable,
    ...(account.accountLabel !== undefined ? { accountLabel: account.accountLabel } : {}),
    ...(error ? { error } : {}),
  });
}

/**
 * Disconnect: remove the session credential AND the local metadata. Also purges
 * any legacy API key an earlier version may have persisted at rest.
 */
async function clearAccount(requestId: string): Promise<void> {
  await Promise.all([
    chrome.storage.local.remove([ACCOUNT_KEY, ACCOUNT_KEY_CREDENTIAL]),
    chrome.storage.session.remove(ACCOUNT_KEY_CREDENTIAL),
  ]);
  const settings = await loadSettings();
  await saveSettings({ ...settings, gatewayOrigin: null, accountLabel: undefined });
  await notifyAccountState(requestId);
}

/**
 * Persist + link an account. Metadata (non-secret) → chrome.storage.local; the
 * API key credential → chrome.storage.session only. Validates via bridge to the
 * workspace gateway (health check) so the project↔extension link is proven, not
 * just stored.
 */
function canonicalGatewayOrigin(value: string): string {
  return new URL(value).origin;
}

function isAllowedCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function saveAccount(gatewayOrigin: string, apiKey: string, requestId: string): Promise<void> {
  if (!isAllowedGatewayOrigin(gatewayOrigin)) {
    await notifyAccountState(requestId, {
      code: "GATEWAY_ORIGIN_NOT_ALLOWED",
      userMessage: "Use an approved GovernWorld gateway origin.",
    });
    return;
  }
  const origin = canonicalGatewayOrigin(gatewayOrigin);
  try {
    const probe = await fetch(`${origin}/health`, { method: "GET", headers: { Accept: "application/json" } });
    if (!probe.ok) throw new Error(`Gateway health check failed (${probe.status})`);
  } catch (e) {
    await notifyAccountState(requestId, { code: "GATEWAY_UNREACHABLE", userMessage: e instanceof Error ? e.message : "Gateway is not reachable at that origin." });
    return;
  }
  try {
    await fetchPlans(origin, apiKey);
  } catch (e) {
    await notifyAccountState(requestId, {
      code: "API_KEY_REJECTED",
      userMessage: e instanceof Error ? e.message : "The gateway did not accept this API key.",
    });
    return;
  }
  const settings = await loadSettings();
  await saveSettings({ ...settings, gatewayOrigin: origin, accountLabel: undefined });
  // Credential first so local metadata can never claim "linked" before the
  // session credential exists.
  await chrome.storage.session.set({ [ACCOUNT_KEY_CREDENTIAL]: apiKey });
  await chrome.storage.local.set({ [ACCOUNT_KEY]: { gatewayOrigin: origin, linked: true } });
  await notifyAccountState(requestId);
  void recordAudit({ ts: new Date().toISOString(), action: "account_linked", gatewayOrigin: origin, outcome: "ok" });
}

/** Fetch the authenticated billing catalog from the linked gateway (metadata only). */
async function fetchPlans(gatewayOrigin: string, apiKey: string): Promise<{ id: string; name: string; priceId: string }[]> {
  const response = await fetch(`${gatewayOrigin}/v1/billing/plans`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Plans request failed (${response.status})`);
  }
  const body = (await response.json()) as { plans?: unknown };
  if (!body || !Array.isArray(body.plans) || !body.plans.every(
    (plan) =>
      typeof plan === "object" &&
      plan !== null &&
      typeof (plan as { id?: unknown }).id === "string" &&
      typeof (plan as { name?: unknown }).name === "string" &&
      typeof (plan as { priceId?: unknown }).priceId === "string"
  )) {
    throw new Error("Gateway returned an invalid billing catalog.");
  }
  return body.plans as { id: string; name: string; priceId: string }[];
}

/**
 * Start a purchase for the given plan on the linked gateway. Resolves the
 * plan's price via the catalog, creates a Checkout Session, and surfaces the
 * checkout URL for the panel to open. Fail-closed: no account metadata, no
 * gateway origin, or no matching plan → error, never a fallback. The API key is
 * sourced ONLY from chrome.storage.session; when the account is linked but the
 * key is absent (browser restart), the purchase is blocked with a re-entry
 * message and no authenticated request is ever sent.
 */
async function purchasePlan(planId: string, requestId: string): Promise<void> {
  const [settings, account] = await Promise.all([loadSettings(), readAccount()]);
  const origin = settings.gatewayOrigin;
  if (!account.linked || !origin) {
    notifyPopup({
      type: "POPUP_ACCOUNT_STATE",
      requestId,
      gatewayOrigin: origin ?? null,
      linked: account.linked,
      credentialAvailable: account.credentialAvailable,
      error: { code: "ACCOUNT_NOT_LINKED", userMessage: "Link your GovernWorld account before purchasing." },
    });
    return;
  }
  const apiKey = await readAccountCredential();
  if (!apiKey) {
    notifyPopup({
      type: "POPUP_ACCOUNT_STATE",
      requestId,
      gatewayOrigin: origin,
      linked: true,
      credentialAvailable: false,
      error: {
        code: "ACCOUNT_CREDENTIAL_REQUIRED",
        userMessage: "Re-enter your key to continue purchases in this browser session.",
      },
    });
    return;
  }

  try {
    const plans = await fetchPlans(origin, apiKey);
    const plan = plans.find((p) => p.id === planId);
    if (!plan) {
      throw new Error(`Plan '${planId}' is not available on this gateway.`);
    }
    const successUrl = chrome.runtime.getURL("sidepanel.html");
    const cancelUrl = chrome.runtime.getURL("sidepanel.html");
    const response = await fetch(`${origin}/v1/billing/checkout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ priceId: plan.priceId, successUrl, cancelUrl }),
    });
    if (!response.ok) {
      throw new Error(`Checkout failed (${response.status})`);
    }
    const body = (await response.json()) as { url?: string };
    if (!body.url || !isAllowedCheckoutUrl(body.url)) {
      throw new Error("Gateway returned an invalid checkout URL.");
    }
    await chrome.tabs.create({ url: body.url });
    notifyPopup({ type: "POPUP_ACCOUNT_PURCHASE_URL", requestId, url: body.url });
  } catch (error) {
    notifyPopup({
      type: "POPUP_ACCOUNT_STATE",
      requestId,
      gatewayOrigin: origin,
      linked: account.linked,
      credentialAvailable: true,
      error: { code: "PURCHASE_FAILED", userMessage: error instanceof Error ? error.message : "Could not start checkout." },
    });
  }
}

// Best-effort purge of any API key an earlier version persisted at rest. The
// gateway key is session-only going forward; if a legacy copy still exists in
// chrome.storage.local it is removed as soon as the service worker starts.
void chrome.storage.local.remove([ACCOUNT_KEY_CREDENTIAL]);

// Staged document bytes are purged when the BROWSER starts, not when this
// service worker wakes.
//
// MV3 terminates an idle service worker after ~30s and restarts it on the next
// event. Running the purge at module scope therefore wiped a user's staged
// document every time the worker cycled, so picking a file, spending longer
// than the idle timeout reviewing findings, and then clicking "Redact selected"
// failed with "The selected file is no longer available." The purge is scoped
// to real lifecycle events, where it belongs.
let startupCleanupError: unknown;
function purgeStagedFilesOnLifecycle(reason: string): void {
  void clearAllFiles().catch((error) => {
    startupCleanupError = error;
    console.warn(`[governworld] staged-file purge failed on ${reason}:`, error);
  });
}

chrome.runtime.onStartup?.addListener(() => {
  purgeStagedFilesOnLifecycle("browser startup");
});

chrome.runtime.onInstalled?.addListener(() => {
  purgeStagedFilesOnLifecycle("extension install/update");
});

// Keyboard shortcuts (manifest "commands"). A command is a deliberate user
// action, so it may inject the content script just like a popup button press.
// Results land in storage.session; the popup shows them on next open.
chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    const requestId = crypto.randomUUID();
    if (command === "scan-page") {
      await handlePopupScan("local", requestId);
      return;
    }
    if (command === "toggle-masks") {
      const tab = await getActiveTab();
      const session = tab?.id ? await readSession(tab.id) : null;
      if (!tab?.id || !session) return;
      const anySelected = session.findings.some((f) => f.selected);
      if (anySelected) await handlePopupRemoveMasks(requestId);
      else await handlePopupApplyMasks(session.findings.map((f) => f.id), requestId);
      return;
    }
    if (command === "open-side-panel") {
      const tab = await getActiveTab();
      const window = tab?.windowId != null ? tab.windowId : (await chrome.windows.getLastFocused()).id;
      if (window != null) {
        await chrome.sidePanel.open({ windowId: window });
      }
    }
  })().catch(() => undefined);
});

const CONTENT_MESSAGE_TYPES = new Set<ExtensionMessage["type"]>([
  "SCAN_RESULT",
  "COPY_REDACTED_TEXT_RESULT",
  "CONTENT_ERROR",
]);

function isTrustedExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL("")));
}

function isTrustedContentScriptSender(sender: chrome.runtime.MessageSender): sender is chrome.runtime.MessageSender & { tab: chrome.tabs.Tab } {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab?.id !== undefined &&
    typeof sender.url === "string" &&
    /^https?:\/\//.test(sender.url)
  );
}

function isAuthorizedMessageSender(type: ExtensionMessage["type"], sender: chrome.runtime.MessageSender): boolean {
  return CONTENT_MESSAGE_TYPES.has(type)
    ? isTrustedContentScriptSender(sender)
    : isTrustedExtensionPageSender(sender);
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const validation = validateMessage(raw);
  if (!validation.ok) {
    sendResponse({ ok: false, error: validation.error });
    return;
  }
  const msg = validation.message;
  if (!isAuthorizedMessageSender(msg.type, sender)) {
    sendResponse({ ok: false, error: "Unauthorized sender" });
    return;
  }

  const run = async () => {
    // Staged-file bytes live for the browser session, so a purge failure here
    // is recorded rather than awaited. Fail closed so a stale document from a
    // previous session can never be redacted against a fresh one.
    if (startupCleanupError) {
      sendResponse({ ok: false, error: "Local document storage cleanup failed." });
      return;
    }
    // Route by message type, not by sender shape: a popup opened as a tab sets
    // sender.tab, and must still reach the popup handlers. Only content-script
    // results genuinely originate from a tab.
    switch (msg.type) {
      case "SCAN_RESULT":
      case "COPY_REDACTED_TEXT_RESULT":
      case "CONTENT_ERROR":
        if (!sender.tab?.id) return;
        if (msg.type === "SCAN_RESULT") await handleContentScanResult(msg, sender.tab.id);
        else if (msg.type === "COPY_REDACTED_TEXT_RESULT") await handleContentCopyResult(msg, sender.tab.id);
        else await handleContentError(msg, sender.tab.id);
        return;
      default:
        break;
    }
    switch (msg.type) {
      case "POPUP_SCAN":
        await handlePopupScan(msg.mode, msg.requestId);
        break;
      case "POPUP_APPLY_MASKS":
        await handlePopupApplyMasks(msg.findingIds, msg.requestId);
        break;
      case "POPUP_REMOVE_MASKS":
        await handlePopupRemoveMasks(msg.requestId);
        break;
      case "POPUP_COPY_REDACTED":
        await handlePopupCopyRedacted(msg.findingIds, msg.requestId);
        break;
      case "POPUP_CLEAR_DATA":
        await handlePopupClearData(msg.requestId);
        break;
      case "POPUP_GET_STATE": {
        notifyPopup({ type: "POPUP_STATE", requestId: msg.requestId, state: await stateForActiveTab() });
        const docSession = getLastSession();
        if (docSession) {
          notifyPopup({ type: "POPUP_DOC_STATE", requestId: msg.requestId, docId: docSession.docId, name: docSession.name, fileKey: docSession.fileKey, mimeType: docSession.mimeType, kind: docSession.kind, pages: docSession.pages });
        }
        void notifyAccountState(msg.requestId);
        notifyPopup({ type: "POPUP_NOTIFICATIONS_STATE", requestId: msg.requestId, granted: await notificationsGranted() });
        notifyPopup({ type: "POPUP_CUSTOM_PATTERNS_STATE", requestId: msg.requestId, patterns: await loadCustomPatterns() });
        notifyPopup({ type: "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE", requestId: msg.requestId, account: await loadCommunityAccount() });
        break;
      }
      case "POPUP_SET_MODE":
        await handlePopupSetMode(msg.mode, msg.requestId);
        break;
      case "POPUP_DOC_PREVIEW":
        await handlePopupDocPreview(msg.fileKey, msg.name, msg.mimeType, msg.kind, msg.requestId);
        break;
      case "POPUP_DOC_REDACT":
        await handlePopupDocRedact(msg.docId, msg.fileKey, msg.name, msg.mimeType, msg.kind, msg.boxes, msg.findingIds, msg.requestId);
        break;
      case "POPUP_DOC_CLEAR":
        await clearDocSession(msg.docId);
        break;
      case "POPUP_DOC_DELIVERY_REPORT":
        // Closes the audit loop for a fallback delivery the worker handed off.
        await settleDeliveryAudit(msg.requestId, msg.delivered);
        break;
      case "POPUP_EXPORT_AUDIT": {
        try {
          const exported = await exportSignedAuditLog();
          notifyPopup({ type: "POPUP_AUDIT_EXPORT", requestId: msg.requestId, ...exported });
        } catch {
          notifyPopup({
            type: "POPUP_STATE",
            requestId: msg.requestId,
            state: buildPopupState(await loadSettings(), null, {
              code: "AUDIT_EXPORT_FAILED",
              userMessage: "Could not export the audit log.",
            }),
          });
        }
        break;
      }
      case "POPUP_UNDO_MASKS":
        await handlePopupUndoMasks(msg.requestId);
        break;
      case "POPUP_SET_NOTIFICATIONS": {
        if (msg.enabled) {
          const granted = (await chrome.permissions.request({ permissions: ["notifications"] })) as boolean;
          const settings = await loadSettings();
          await saveSettings({ ...settings, notificationsEnabled: granted });
          notifyPopup({ type: "POPUP_NOTIFICATIONS_STATE", requestId: msg.requestId, granted });
        } else {
          await chrome.permissions.remove({ permissions: ["notifications"] });
          const settings = await loadSettings();
          await saveSettings({ ...settings, notificationsEnabled: false });
          notifyPopup({ type: "POPUP_NOTIFICATIONS_STATE", requestId: msg.requestId, granted: false });
        }
        break;
      }
      case "POPUP_ACCOUNT_SAVE":
        await saveAccount(msg.gatewayOrigin, msg.apiKey, msg.requestId);
        break;
      case "POPUP_ACCOUNT_CLEAR":
        await clearAccount(msg.requestId);
        break;
      case "POPUP_ACCOUNT_PURCHASE":
        await purchasePlan(msg.planId, msg.requestId);
        break;
      case "POPUP_WIZARD_ANALYZE": {
        const analysis = analyzeExamples(msg.positiveExamples, "custom", msg.negativeExamples);
        notifyPopup({ type: "POPUP_WIZARD_ANALYSIS_RESULT", requestId: msg.requestId, proposals: [analysis] });
        break;
      }
      case "POPUP_WIZARD_TEST": {
        const testResult = testPattern(msg.regex, "g", [msg.sampleText]);
        notifyPopup({ type: "POPUP_WIZARD_TEST_RESULT", requestId: msg.requestId, testResult });
        break;
      }
      case "POPUP_CUSTOM_PATTERNS_GET": {
        const patterns = await loadCustomPatterns();
        notifyPopup({ type: "POPUP_CUSTOM_PATTERNS_STATE", requestId: msg.requestId, patterns });
        break;
      }
      case "POPUP_CUSTOM_PATTERN_SAVE": {
        const patterns = await saveCustomPattern(msg.pattern);
        notifyPopup({ type: "POPUP_CUSTOM_PATTERNS_STATE", requestId: msg.requestId, patterns });
        break;
      }
      case "POPUP_CUSTOM_PATTERN_DELETE": {
        const patterns = await deleteCustomPattern(msg.patternId);
        notifyPopup({ type: "POPUP_CUSTOM_PATTERNS_STATE", requestId: msg.requestId, patterns });
        break;
      }
      case "POPUP_COMMUNITY_ACCOUNT_GET": {
        const account = await loadCommunityAccount();
        notifyPopup({ type: "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE", requestId: msg.requestId, account });
        break;
      }
      case "POPUP_COMMUNITY_ACCOUNT_LINK_FREE": {
        notifyPopup({ type: "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE", requestId: msg.requestId, account: null });
        notifyPopup({ type: "POPUP_COMMUNITY_CONTRIBUTE_RESULT", requestId: msg.requestId, success: false, error: "Community account linking is unavailable until server authorization is configured." });
        break;
      }
      case "POPUP_COMMUNITY_ACCOUNT_UNLINK": {
        await unlinkCommunityAccount();
        notifyPopup({ type: "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE", requestId: msg.requestId, account: null });
        break;
      }
      case "POPUP_COMMUNITY_CONTRIBUTE": {
        notifyPopup({ type: "POPUP_COMMUNITY_CONTRIBUTE_RESULT", requestId: msg.requestId, success: false, error: "Community contributions are unavailable until server authorization and consent recording are configured." });
        break;
      }
      case "POPUP_COMMUNITY_FETCH_COMMUNITY_RULES": {
        notifyPopup({ type: "POPUP_COMMUNITY_COMMUNITY_RULES_STATE", requestId: msg.requestId, rules: [], error: "Community rule retrieval is unavailable until the server integration is configured." });
        break;
      }
      default:
        break;
    }
  };

  void (async () => {
    try {
      await run();
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
  })();
  return true; // async response
});

// Clean up stale sessions for closed tabs.
chrome.tabs.onRemoved.addListener((tabId) => {
  const pending = pendingScans.get(tabId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingScans.delete(tabId);
  }
  void chrome.storage.session.remove(sessionKey(tabId));
});