// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { detect, maskValue, placeholderLabelFor } from "./detect.js";
import type { RawMatch } from "./detect.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../shared/settings.js";
import type { FindingCategory, Settings } from "../shared/settings.js";
import type { CustomPattern } from "../shared/customPatterns.js";

/**
 * Feature Area 2: Proactive 'Paste & Prompt' Shield / Chat & LLM Guard.
 *
 * Intercepts clipboard paste and beforeinput events on input, textarea,
 * and contenteditable elements (optimized for ChatGPT, Claude, Slack, Jira, forms).
 * When sensitive data (API keys, SSNs, credit cards, PHI, etc.) is detected,
 * it intercepts the paste and presents a floating Shadow DOM dialog with
 * masked previews and 3 actions: [Sanitize & Paste], [Paste Unchanged], and [Cancel].
 */

export const CATEGORY_LABELS: Record<string, string> = {
  email: "Email Address",
  phone: "Phone Number",
  ssn: "SSN",
  dob: "Date of Birth",
  medical_record_number: "Medical Record Number (MRN)",
  member_id: "Member ID",
  npi: "Provider NPI",
  dea: "DEA Number",
  mbi: "Medicare ID (MBI)",
  address: "Street Address",
  payment_card: "Payment Card",
  secrets: "API Key / Secret",
  possible_name: "Personal Name",
  custom: "Custom Pattern",
};

/** Specific secret label resolver to make the preview dialog crystal clear */
export function getFindingDisplayName(category: FindingCategory, value?: string): string {
  if (category === "secrets" && value) {
    if (/^sk-ant-/.test(value)) return "Anthropic API Key";
    if (/^sk-[A-Za-z0-9]/.test(value)) return "OpenAI API Key";
    if (/^AIza/.test(value)) return "Google API Key";
    if (/^(?:rk|sk|pk)_(?:live|test)_/.test(value)) return "Stripe API Key";
    if (/^(?:ghp_|github_pat_)/.test(value)) return "GitHub Token";
    if (/^xox[baprs]-/.test(value)) return "Slack Token";
    if (/^SG\./.test(value)) return "SendGrid Key";
    if (/^npm_/.test(value)) return "npm Token";
    if (/^SK[0-9a-fA-F]{32}/.test(value)) return "Twilio Key";
    if (/^dapi-/.test(value)) return "Databricks Token";
    if (/^eyJ/.test(value)) return "JSON Web Token (JWT)";
    if (/BEGIN.*PRIVATE KEY/.test(value)) return "Private Key";
    if (/^(?:postgres|mysql|mongodb|redis|amqp|mssql):/i.test(value)) return "Database Connection String";
  }
  return CATEGORY_LABELS[category] ?? category;
}

/** Pure detector helper for paste inspection */
export function detectPasteFindings(
  text: string,
  enabledCategories: FindingCategory[] = DEFAULT_SETTINGS.enabledCategories,
  customPatterns: CustomPattern[] = []
): RawMatch[] {
  if (!text || typeof text !== "string" || text.trim().length === 0) return [];
  return detect(text, enabledCategories, customPatterns);
}

/** Pure sanitization helper replacing detected spans with [REDACTED] placeholders */
export function sanitizePastedText(
  text: string,
  matches: RawMatch[],
  placeholder = "[REDACTED]"
): string {
  if (!matches || matches.length === 0) return text;
  // Sort descending by start to safely slice from end to beginning
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  let result = text;
  for (const match of sorted) {
    result = result.slice(0, match.start) + placeholder + result.slice(match.end);
  }
  return result;
}

function isHtmlElement(node: unknown): node is HTMLElement {
  if (!node || typeof node !== "object") return false;
  if (typeof HTMLElement !== "undefined") return node instanceof HTMLElement;
  return (node as any).nodeType === 1;
}

function isInputElement(node: unknown): node is HTMLInputElement {
  if (!node || typeof node !== "object") return false;
  if (typeof HTMLInputElement !== "undefined") return node instanceof HTMLInputElement;
  return isHtmlElement(node) && (node as any).tagName === "INPUT";
}

function isTextAreaElement(node: unknown): node is HTMLTextAreaElement {
  if (!node || typeof node !== "object") return false;
  if (typeof HTMLTextAreaElement !== "undefined") return node instanceof HTMLTextAreaElement;
  return isHtmlElement(node) && (node as any).tagName === "TEXTAREA";
}

/** Insert text safely into input, textarea, or contenteditable targets */
export function insertTextIntoElement(target: HTMLElement, text: string): boolean {
  target.focus?.();

  // 1. Text input or textarea
  if (isInputElement(target) || isTextAreaElement(target)) {
    const inputOrTextarea = target as HTMLInputElement | HTMLTextAreaElement;
    const start = inputOrTextarea.selectionStart ?? inputOrTextarea.value.length;
    const end = inputOrTextarea.selectionEnd ?? inputOrTextarea.value.length;

    let inserted = false;
    try {
      if (typeof document !== "undefined" && typeof document.execCommand === "function") {
        inserted = document.execCommand("insertText", false, text);
      }
    } catch {
      inserted = false;
    }

    if (!inserted) {
      if (typeof inputOrTextarea.setRangeText === "function") {
        inputOrTextarea.setRangeText(text, start, end, "end");
      } else {
        inputOrTextarea.value = inputOrTextarea.value.slice(0, start) + text + inputOrTextarea.value.slice(end);
      }
      if (typeof Event !== "undefined") {
        inputOrTextarea.dispatchEvent(new Event("input", { bubbles: true }));
        inputOrTextarea.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    return true;
  }

  // 2. Contenteditable element or child of contenteditable
  const editable = target.isContentEditable
    ? target
    : (target.closest?.("[contenteditable='true'], [contenteditable='']") as HTMLElement | null);

  if (editable) {
    editable.focus();
    let inserted = false;
    try {
      if (typeof document.execCommand === "function") {
        inserted = document.execCommand("insertText", false, text);
      }
    } catch {
      inserted = false;
    }

    if (!inserted && typeof window.getSelection === "function") {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const textNode = (target.ownerDocument || document).createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        sel.removeAllRanges();
        sel.addRange(range);
        editable.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return true;
  }

  return false;
}

export interface PasteGuardDialogCallbacks {
  onSanitize: () => void;
  onRaw: () => void;
  onCancel: () => void;
}

export interface ActiveDialogHandle {
  host: HTMLElement;
  close: () => void;
}

/** Stylesheet for the isolated Shadow DOM modal */
const MODAL_STYLES = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: #e2e8f0;
  pointer-events: auto;
}

*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

.gw-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(2px);
  z-index: 1;
}

.gw-dialog {
  position: fixed;
  z-index: 2;
  width: 380px;
  max-width: calc(100vw - 32px);
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(34, 211, 238, 0.15);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: gw-pop-in 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes gw-pop-in {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.gw-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gw-shield-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}

.gw-header-text {
  flex: 1;
  min-width: 0;
}

.gw-title {
  font-size: 14px;
  font-weight: 600;
  color: #f8fafc;
  display: flex;
  align-items: center;
  gap: 6px;
}

.gw-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.gw-subtitle {
  font-size: 11px;
  color: #94a3b8;
}

.gw-content {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 10px;
  max-height: 160px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gw-finding-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(51, 65, 85, 0.5);
}

.gw-finding-item:last-child {
  padding-bottom: 0;
  border-bottom: none;
}

.gw-finding-label {
  font-size: 11px;
  font-weight: 600;
  color: #38bdf8;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.gw-finding-preview {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  color: #f1f5f9;
  word-break: break-all;
  background: rgba(15, 23, 42, 0.6);
  padding: 2px 6px;
  border-radius: 4px;
}

.gw-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gw-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.12s ease;
  outline: none;
}

.gw-btn:focus-visible {
  box-shadow: 0 0 0 2px #0f172a, 0 0 0 4px #38bdf8;
}

.gw-btn-primary {
  background: #0284c7;
  color: #ffffff;
  border-color: #0369a1;
  font-weight: 600;
}

.gw-btn-primary:hover {
  background: #0369a1;
}

.gw-btn-ghost {
  background: transparent;
  color: #cbd5e1;
  border-color: #475569;
}

.gw-btn-ghost:hover {
  background: rgba(51, 65, 85, 0.4);
  color: #f8fafc;
}

.gw-btn-danger {
  background: transparent;
  color: #94a3b8;
  border-color: transparent;
}

.gw-btn-danger:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #f87171;
}

.gw-kbd {
  font-size: 10px;
  font-family: inherit;
  opacity: 0.75;
  background: rgba(0, 0, 0, 0.2);
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.15);
}
`;

/** Create and show the floating Shadow DOM dialog */
export function showPasteGuardDialog(
  doc: Document,
  target: HTMLElement,
  matches: RawMatch[],
  callbacks: PasteGuardDialogCallbacks
): ActiveDialogHandle {
  // Clean up any existing instance first
  const existingHost = doc.getElementById("__governworld-paste-guard-host");
  if (existingHost) {
    existingHost.remove();
  }

  const host = doc.createElement("div");
  host.id = "__governworld-paste-guard-host";
  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = doc.createElement("style");
  styleEl.textContent = MODAL_STYLES;
  shadow.appendChild(styleEl);

  const backdrop = doc.createElement("div");
  backdrop.className = "gw-backdrop";

  const dialog = doc.createElement("div");
  dialog.className = "gw-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "gw-pg-title");

  // Position calculation
  const targetRect = target.getBoundingClientRect();
  const viewportWidth = (doc.defaultView?.innerWidth) ?? 1024;
  const viewportHeight = (doc.defaultView?.innerHeight) ?? 768;
  const dialogWidth = 380;
  const approxDialogHeight = 260;

  let left = targetRect.left;
  if (left + dialogWidth > viewportWidth - 16) {
    left = Math.max(16, viewportWidth - dialogWidth - 16);
  }
  if (left < 16) left = 16;

  let top = targetRect.bottom + 8;
  if (top + approxDialogHeight > viewportHeight - 16) {
    // If overflowing viewport bottom, position above the target if space permits
    if (targetRect.top - approxDialogHeight - 8 >= 16) {
      top = targetRect.top - approxDialogHeight - 8;
    } else {
      top = Math.max(16, viewportHeight - approxDialogHeight - 16);
    }
  }

  dialog.style.left = `${Math.round(left)}px`;
  dialog.style.top = `${Math.round(top)}px`;

  // Header
  const header = doc.createElement("div");
  header.className = "gw-header";
  header.innerHTML = `
    <svg class="gw-shield-icon" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="gw-shield-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#22d3ee" />
          <stop offset="1" stop-color="#0ea5e9" />
        </linearGradient>
      </defs>
      <path d="M24 4 L41 10 V23 C41 35 34 42 24 46 C14 42 7 35 7 23 V10 Z" fill="#0f172a" stroke="url(#gw-shield-grad)" stroke-width="2.6" />
      <path d="M24 11 L35 14.6 V23 C35 31 30.6 36.4 24 39 C17.4 36.4 13 31 13 23 V14.6 Z" fill="none" stroke="#22d3ee" stroke-width="1.6" opacity="0.85" />
      <rect x="16" y="24" width="16" height="4.4" rx="2.2" fill="#ef4444" />
      <circle cx="24" cy="32.4" r="1.8" fill="#34d399" />
    </svg>
    <div class="gw-header-text">
      <div class="gw-title" id="gw-pg-title">
        GovernWorld Paste Shield
        <span class="gw-badge">${matches.length} Sensitive ${matches.length === 1 ? "Item" : "Items"}</span>
      </div>
      <div class="gw-subtitle">On-device privacy check intercepted sensitive data</div>
    </div>
  `;

  // Findings list
  const content = doc.createElement("div");
  content.className = "gw-content";

  for (const match of matches) {
    const item = doc.createElement("div");
    item.className = "gw-finding-item";
    const displayName = getFindingDisplayName(match.category, match.value);
    const masked = maskValue(match.category, match.value);

    // Page-derived values are rendered as text, never parsed as HTML: a
    // hostile page could otherwise inject markup into this dialog through a
    // crafted match value (e.g. an email domain or a secret's head character).
    const label = doc.createElement("div");
    label.className = "gw-finding-label";
    const nameSpan = doc.createElement("span");
    nameSpan.textContent = displayName;
    const confSpan = doc.createElement("span");
    confSpan.style.fontSize = "10px";
    confSpan.style.color = "#94a3b8";
    confSpan.textContent = `${Math.round(match.confidence * 100)}%`;
    label.append(nameSpan, confSpan);
    const preview = doc.createElement("div");
    preview.className = "gw-finding-preview";
    preview.textContent = masked;
    item.append(label, preview);
    content.appendChild(item);
  }

  // Action buttons
  const actions = doc.createElement("div");
  actions.className = "gw-actions";

  const btnSanitize = doc.createElement("button");
  btnSanitize.className = "gw-btn gw-btn-primary";
  btnSanitize.id = "gw-btn-sanitize";
  btnSanitize.innerHTML = `Sanitize &amp; Paste <span class="gw-kbd">↵ Enter</span>`;

  const btnRaw = doc.createElement("button");
  btnRaw.className = "gw-btn gw-btn-ghost";
  btnRaw.id = "gw-btn-raw";
  btnRaw.textContent = "Paste Unchanged";

  const btnCancel = doc.createElement("button");
  btnCancel.className = "gw-btn gw-btn-danger";
  btnCancel.id = "gw-btn-cancel";
  btnCancel.innerHTML = `Cancel <span class="gw-kbd">Esc</span>`;

  actions.append(btnSanitize, btnRaw, btnCancel);
  dialog.append(header, content, actions);
  shadow.append(backdrop, dialog);

  (doc.body || doc.documentElement).appendChild(host);

  let isClosed = false;
  const close = () => {
    if (isClosed) return;
    isClosed = true;
    doc.removeEventListener("keydown", handleKeydown, true);
    backdrop.removeEventListener("click", handleBackdropClick);
    host.remove();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      callbacks.onCancel();
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // If focus is specifically on btnRaw or btnCancel, activate that button
      const activeEl = shadow.activeElement;
      if (activeEl === btnRaw) {
        e.preventDefault();
        e.stopPropagation();
        close();
        callbacks.onRaw();
      } else if (activeEl === btnCancel) {
        e.preventDefault();
        e.stopPropagation();
        close();
        callbacks.onCancel();
      } else {
        e.preventDefault();
        e.stopPropagation();
        close();
        callbacks.onSanitize();
      }
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    close();
    callbacks.onCancel();
  };

  btnSanitize.addEventListener("click", () => {
    close();
    callbacks.onSanitize();
  });

  btnRaw.addEventListener("click", () => {
    close();
    callbacks.onRaw();
  });

  btnCancel.addEventListener("click", () => {
    close();
    callbacks.onCancel();
  });

  backdrop.addEventListener("click", handleBackdropClick);
  doc.addEventListener("keydown", handleKeydown, true);

  // Focus primary button for fast Enter response
  setTimeout(() => {
    try {
      btnSanitize.focus();
    } catch {
      // ignore
    }
  }, 0);

  return { host, close };
}

/** Check if an element is an editable target */
export function isEditableElement(el: unknown): el is HTMLElement {
  if (!isHtmlElement(el)) return false;
  if (isInputElement(el)) {
    const type = (el.type || "").toLowerCase();
    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
  }
  if (isTextAreaElement(el)) return true;
  if (el.isContentEditable) return true;
  if (typeof el.closest === "function" && el.closest("[contenteditable='true'], [contenteditable='']")) return true;
  if (el.ownerDocument && el.ownerDocument.designMode === "on") return true;
  return false;
}

/**
 * Initialize Paste Guard on a given Document context.
 * Returns a teardown function for clean cleanup in tests or page lifecycle.
 */
export function initPasteGuard(doc: Document = document): () => void {
  let cachedSettings: Settings = { ...DEFAULT_SETTINGS };
  let cachedCustomPatterns: CustomPattern[] = [];
  let isHandlingEvent = false;

  // Load settings and custom patterns asynchronously from extension storage if available
  const loadStored = async () => {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const stored = await chrome.storage.local.get(["settings", "customPatterns"]);
        if (stored.settings) {
          cachedSettings = normalizeSettings(stored.settings);
        }
        if (Array.isArray(stored.customPatterns)) {
          cachedCustomPatterns = stored.customPatterns;
        }
      }
    } catch {
      // Fall back to defaults
    }
  };

  void loadStored();

  // Listen for real-time settings changes
  const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
    if (areaName === "local") {
      if (changes.settings) {
        cachedSettings = normalizeSettings(changes.settings.newValue);
      }
      if (changes.customPatterns && Array.isArray(changes.customPatterns.newValue)) {
        cachedCustomPatterns = changes.customPatterns.newValue;
      }
    }
  };

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener(storageListener);
  }

  const handlePastedContent = (
    text: string,
    target: HTMLElement,
    originalEvent: Event
  ) => {
    if (!cachedSettings.pasteGuardEnabled) return;
    if (!text || text.trim().length === 0) return;

    const matches = detectPasteFindings(text, cachedSettings.enabledCategories, cachedCustomPatterns);
    if (matches.length === 0) return;

    // Intercept event
    originalEvent.preventDefault();
    if (typeof originalEvent.stopImmediatePropagation === "function") {
      originalEvent.stopImmediatePropagation();
    } else {
      originalEvent.stopPropagation();
    }

    isHandlingEvent = true;
    try {
      showPasteGuardDialog(doc, target, matches, {
        onSanitize: () => {
          isHandlingEvent = false;
          const sanitized = sanitizePastedText(text, matches);
          insertTextIntoElement(target, sanitized);
        },
        onRaw: () => {
          isHandlingEvent = false;
          insertTextIntoElement(target, text);
        },
        onCancel: () => {
          isHandlingEvent = false;
        },
      });
    } catch {
      isHandlingEvent = false;
      insertTextIntoElement(target, text);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    if (isHandlingEvent) return;
    const target = e.target;
    if (!isEditableElement(target)) return;

    const text = e.clipboardData?.getData("text/plain") || e.clipboardData?.getData("text") || "";
    if (text) {
      handlePastedContent(text, target, e);
    }
  };

  const onBeforeInput = (e: InputEvent) => {
    if (isHandlingEvent) return;
    if (e.inputType !== "insertFromPaste") return;
    const target = e.target;
    if (!isEditableElement(target)) return;

    const text = e.dataTransfer?.getData("text/plain") || e.dataTransfer?.getData("text") || "";
    if (text) {
      handlePastedContent(text, target, e);
    }
  };

  doc.addEventListener("paste", onPaste as EventListener, true);
  doc.addEventListener("beforeinput", onBeforeInput as EventListener, true);

  return () => {
    doc.removeEventListener("paste", onPaste as EventListener, true);
    doc.removeEventListener("beforeinput", onBeforeInput as EventListener, true);
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged?.removeListener) {
      chrome.storage.onChanged.removeListener(storageListener);
    }
    const host = doc.getElementById("__governworld-paste-guard-host");
    if (host) host.remove();
  };
}
