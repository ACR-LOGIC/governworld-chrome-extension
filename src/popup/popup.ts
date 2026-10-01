// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { validateMessage } from "../shared/messages.js";
import { previewObjectUrl } from "../shared/docStore.js";
import { docStoreFile, docDeleteFile, markDocumentStaged } from "../shared/docDb.js";
import {
  ALL_CATEGORIES,
  loadSettings,
  saveSettings,
  resetSettings,
  PRESET_CATEGORIES,
  PRESET_LABELS,
  type PresetId,
  type ProtectionMode,
  type Settings,
  type LanguageCode,
  type FontSizeScale,
  type SessionTimeoutOption,
} from "../shared/settings.js";
import {
  loadEnterprisePolicy,
  resolveEffectiveProtection,
  type EffectiveProtection,
} from "../shared/enterprisePolicy.js";
import {
  ALWAYS_ON_ORIGINS,
  describeProtectionState,
  queryAlwaysOnCapability,
  type AlwaysOnCapability,
} from "../shared/siteAccess.js";
import { recordAudit } from "../shared/audit.js";
import { BUNDLED_OCR_LANGUAGES } from "../shared/ocrLanguages.js";
import { t, getCategoryLabel, getPresetLabel } from "../shared/i18n.js";
import type {
  DocKind,
  Finding,
  FindingCategory,
  PopupState,
  PopupMessage,
  ScanMode,
  DocPageMeta,
  PopupFromWorker,
  Rect,
  RedactionStyle,
} from "../shared/types.js";
import type { CustomPattern, CommunityAccount, CommunityRule } from "../shared/customPatterns.js";
import type { WizardAnalysis } from "../shared/wizardAnalyzer.js";
import type { ImageCandidate } from "../shared/messages.js";

export function isInternalExtensionUrl(url?: string): boolean {
  if (!url) return false;
  return (
    url.startsWith("chrome-extension://") ||
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("view-source:")
  );
}

/**
 * A tab GovernWorld can actually act on: an identified, ordinary web page.
 * Internal extension pages and the extension's own URLs are never eligible.
 */
export function isScannableTab(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab {
  if (!tab?.id || !tab.url) return false;
  if (isInternalExtensionUrl(tab.url)) return false;
  return tab.url.startsWith("http://") || tab.url.startsWith("https://");
}

/**
 * Resolve the web page the user is looking at. Only a real web page is ever
 * returned: the earlier version fell back to the focused tab after filtering
 * extension URLs out, so one of our own pages could be returned as a scan
 * target. Callers already treat undefined as "nothing to act on".
 */
export async function getActiveWebTab(): Promise<chrome.tabs.Tab | undefined> {
  const [focusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (isScannableTab(focusedTab)) {
    return focusedTab;
  }
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isScannableTab(currentTab)) {
    return currentTab;
  }
  const allTabs = await chrome.tabs.query({});
  return allTabs.find((t) => t.active && isScannableTab(t));
}

export async function ensureContentScriptReady(tabId: number): Promise<boolean> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, { type: "PING" })) as { ok?: boolean } | undefined;
    if (response?.ok) return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await new Promise((resolve) => setTimeout(resolve, 80));
      return true;
    } catch (error) {
      console.warn(`[governworld] Unable to dynamically inject content script on tab ${tabId}:`, error);
      return false;
    }
  }
  return false;
}


export let currentLang: LanguageCode = "en";

/**
 * The last scan state seen by the popup.
 *
 * Declared here because both `renderState` and the image-capture flow need it:
 * a capture clears the scan surface, and it has to know which mode was in use
 * to leave the popup in a valid state rather than inventing one.
 */
let lastState: PopupState | null = null;

export const CATEGORY_LABELS: Record<string, string> = {
  email: "Email address",
  phone: "US phone number",
  ssn: "Social Security number (SSN / ITIN)",
  dob: "Date of birth",
  medical_record_number: "Medical record number (MRN)",
  member_id: "Member / patient ID",
  npi: "Provider NPI",
  dea: "DEA registration",
  mbi: "Medicare Beneficiary ID (MBI)",
  address: "US street address",
  payment_card: "Payment card (Luhn)",
  secrets: "API keys & secrets",
  possible_name: "Possible name",
  canadian_sin: "Canadian SIN",
  uk_nhs: "UK NHS Number",
  aadhaar: "Indian Aadhaar",
  pan_india: "Indian PAN Card",
  australian_tfn: "Australian TFN",
  cpf: "Brazilian CPF",
  custom: "Custom pattern",
};

export const HEALTHCARE_CATEGORIES: FindingCategory[] = [
  "medical_record_number",
  "member_id",
  "npi",
  "dea",
  "mbi",
  "ssn",
  "dob",
  "address",
  "phone",
  "email",
  "possible_name",
  "uk_nhs",
];

export const INTERNATIONAL_CATEGORIES: FindingCategory[] = [
  "canadian_sin",
  "uk_nhs",
  "aadhaar",
  "pan_india",
  "australian_tfn",
  "cpf",
  "email",
  "phone",
  "address",
  "dob",
  "possible_name",
  "payment_card",
];

export const FINANCIAL_CATEGORIES: FindingCategory[] = [
  "payment_card",
  "ssn",
  "canadian_sin",
  "pan_india",
  "australian_tfn",
  "cpf",
  "address",
  "phone",
  "email",
];

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.9) return "High";
  if (confidence >= 0.7) return "Medium";
  return "Low";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function requestId(): string {
  return crypto.randomUUID();
}

const MAX_DOC_BYTES = 20 * 1024 * 1024;

/**
 * Stage the chosen file for the worker to read.
 *
 * `markDocumentStaged` runs BEFORE the write, not after: the worker's
 * install-time purge empties the whole store, and if it started first it would
 * delete a document the popup had already written. Marking first means the purge
 * sees a staged document and skips, whichever of the two runs first.
 */
async function storeFile(fileKey: string, bytes: ArrayBuffer): Promise<void> {
  await markDocumentStaged();
  await docStoreFile(fileKey, bytes);
}

async function deleteFile(fileKey: string): Promise<void> {
  await docDeleteFile(fileKey);
}

/** Web Speech API Speech Synthesis and Screen Reader Live Region for audio announcements */
export function speakAnnouncement(text: string, settings?: Settings): void {
  // Update dedicated ARIA live region for screen reader accessibility
  let liveRegion = document.getElementById("sr-announcements");
  if (!liveRegion) {
    liveRegion = document.createElement("div");
    liveRegion.id = "sr-announcements";
    liveRegion.className = "visually-hidden";
    liveRegion.setAttribute("role", "status");
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.setAttribute("aria-atomic", "true");
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = "";
  liveRegion.textContent = text;

  if (!settings?.speechAnnouncements) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const langMap: Record<LanguageCode, string> = {
      en: "en-US",
      es: "es-ES",
      fr: "fr-FR",
      de: "de-DE",
      ja: "ja-JP",
      pt: "pt-BR",
      zh: "zh-CN",
    };
    utterance.lang = langMap[settings.language] || "en-US";
    utterance.rate = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Non-blocking catch
  }
}

export function applyUiLanguage(lang: LanguageCode): void {
  currentLang = lang;
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    if (key) {
      element.textContent = t(lang, key);
    }
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => {
    const key = element.getAttribute("data-i18n-title");
    if (key) {
      element.title = t(lang, key);
    }
  });
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-placeholder]").forEach((element) => {
    const key = element.getAttribute("data-i18n-placeholder");
    if (key) {
      element.placeholder = t(lang, key);
    }
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((element) => {
    const key = element.getAttribute("data-i18n-aria-label");
    if (key) {
      element.setAttribute("aria-label", t(lang, key));
    }
  });

  const presetSelect = document.getElementById("preset-select") as HTMLSelectElement | null;
  if (presetSelect) {
    Array.from(presetSelect.options).forEach((opt) => {
      opt.textContent = getPresetLabel(lang, opt.value);
    });
  }
}

export function applyAccessibilitySettings(settings: Settings): void {
  const root = document.documentElement;
  const body = document.body;

  root.setAttribute("data-font-size", settings.fontSize);
  body.setAttribute("data-font-size", settings.fontSize);

  root.setAttribute("data-high-contrast", String(settings.highContrast));
  body.setAttribute("data-high-contrast", String(settings.highContrast));

  root.setAttribute("data-dyslexia", String(settings.dyslexiaMode));
  body.setAttribute("data-dyslexia", String(settings.dyslexiaMode));

  root.setAttribute("data-reduced-motion", String(settings.reducedMotion));
  body.setAttribute("data-reduced-motion", String(settings.reducedMotion));

  // Handle Verbose ARIA Mode
  const scanBtn = document.getElementById("scan-btn");
  const applyMasksBtn = document.getElementById("apply-masks-btn");
  const docDropzone = document.getElementById("doc-dropzone");
  const docRedactBtn = document.getElementById("doc-redact-btn");

  if (settings.ariaVerboseMode) {
    scanBtn?.setAttribute(
      "aria-label",
      "Scan current webpage for protected health information, financial data, and personal identifiers"
    );
    applyMasksBtn?.setAttribute(
      "aria-label",
      "Applies non-destructive visual privacy overlays over sensitive text on the active page"
    );
    docDropzone?.setAttribute(
      "aria-label",
      "Upload PDF, Word document, or image to redact sensitive data locally with pixel-level verification"
    );
    docRedactBtn?.setAttribute(
      "aria-label",
      "Permanently redacts selected sensitive findings into a flattened downloadable file copy"
    );
  } else {
    scanBtn?.setAttribute("aria-label", "Scan Page (Alt+Shift+S)");
    applyMasksBtn?.setAttribute("aria-label", "Apply selected masks");
    docDropzone?.setAttribute("aria-label", "Document upload dropzone");
    docRedactBtn?.setAttribute("aria-label", "Redact selected and download");
  }
}

export async function renderCategories(settings: {
  enabledCategories: FindingCategory[];
  lockedCategories?: FindingCategory[];
  language?: LanguageCode;
}): Promise<void> {
  const list = document.getElementById("category-list") as HTMLFieldSetElement | null;
  if (!list) return;
  const lang = settings.language || currentLang || "en";
  const locked = new Set<FindingCategory>(settings.lockedCategories ?? []);
  list.replaceChildren();
  for (const category of ALL_CATEGORIES) {
    const label = el("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = category;
    check.checked = settings.enabledCategories.includes(category);
    check.setAttribute("role", "switch");
    check.setAttribute("aria-checked", check.checked ? "true" : "false");
    if (locked.has(category)) {
      // Admin-mandated: visible but not switchable. Enforcement does not rely
      // on this attribute — the change handler below re-adds locked
      // categories and the content guard merges them independently.
      check.disabled = true;
      check.title = t(lang, "managed_lock_notice");
    }
    const span = el("span", undefined, getCategoryLabel(lang, category));
    label.append(check, span);
    check.addEventListener("change", async () => {
      if (check.disabled) {
        check.checked = true;
        return;
      }
      check.setAttribute("aria-checked", check.checked ? "true" : "false");
      const current = await loadSettings();
      const priorPreset = presetForCategories(current.enabledCategories);
      const set = new Set(current.enabledCategories);
      if (check.checked) set.add(category);
      else set.delete(category);
      // A locked category can never be removed, even programmatically.
      for (const mandated of (await loadEnterprisePolicy()).enforcedCategories) set.add(mandated);
      const next = ALL_CATEGORIES.filter((c) => set.has(c));
      await saveSettings({ ...current, enabledCategories: next });
      await renderCategories({ enabledCategories: next, language: current.language });
      if (priorPreset !== "custom") {
        await recordAudit({
          ts: new Date().toISOString(),
          action: "preset_overridden",
          presetId: priorPreset,
          enabledCategories: next,
          outcome: "ok",
        });
      }
    });
    list.appendChild(label);
  }
  updatePresetSelector(settings.enabledCategories);
}

/** The preset whose category set exactly matches the given set, else "custom". */
export function presetForCategories(enabledCategories: FindingCategory[]): PresetId {
  let matchedPreset: PresetId = "custom";
  for (const [presetId, categories] of Object.entries(PRESET_CATEGORIES)) {
    const presetSet = new Set(categories);
    const enabledSet = new Set(enabledCategories);
    if (presetSet.size === enabledSet.size && [...presetSet].every((c) => enabledSet.has(c))) {
      matchedPreset = presetId as PresetId;
      break;
    }
  }
  return matchedPreset;
}

function updatePresetSelector(enabledCategories: FindingCategory[]): void {
  const select = document.getElementById("preset-select") as HTMLSelectElement | null;
  if (!select) return;
  select.value = presetForCategories(enabledCategories);
}

export async function applyPreset(presetId: PresetId): Promise<void> {
  if (presetId === "custom") return;
  const categories = PRESET_CATEGORIES[presetId];
  if (!categories) return;
  const current = await loadSettings();
  const previousPreset = presetForCategories(current.enabledCategories);
  // Admin-mandated categories survive preset switches.
  const enforced = (await loadEnterprisePolicy()).enforcedCategories;
  const merged = ALL_CATEGORIES.filter((c) => categories.includes(c) || enforced.includes(c));
  await saveSettings({ ...current, enabledCategories: merged });
  await renderCategories({ enabledCategories: merged, language: current.language });
  if (previousPreset !== presetId) {
    await recordAudit({
      ts: new Date().toISOString(),
      action: "preset_applied",
      presetId,
      enabledCategories: merged,
      outcome: "ok",
    });
  }
}

export async function applyCategoryFilter(categories: FindingCategory[]): Promise<void> {
  const current = await loadSettings();
  const valid = ALL_CATEGORIES.filter((c) => categories.includes(c));
  const enforced = (await loadEnterprisePolicy()).enforcedCategories;
  const merged = ALL_CATEGORIES.filter((c) => valid.includes(c) || enforced.includes(c));
  await saveSettings({ ...current, enabledCategories: merged });
  await renderCategories({ enabledCategories: merged, language: current.language });
}

function renderFindings(findings: Finding[]): void {
  const list = document.getElementById("findings-list") as HTMLUListElement | null;
  const count = document.getElementById("results-count") as HTMLSpanElement | null;
  const applyBtn = document.getElementById("apply-masks-btn") as HTMLButtonElement | null;
  if (!list || !count || !applyBtn) return;
  list.replaceChildren();
  count.textContent = `${findings.length} detected`;
  let selected = 0;
  for (const finding of findings) {
    const reportOnly = finding.source === "attr";
    if (finding.selected) selected += 1;
    const item = el("li", "finding");
    if (reportOnly) item.classList.add("finding--report-only");
    let check: HTMLInputElement | null = null;
    if (!reportOnly) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "finding__check";
      checkbox.value = finding.id;
      checkbox.checked = finding.selected;
      checkbox.setAttribute("aria-checked", finding.selected ? "true" : "false");
      checkbox.setAttribute("aria-label", `Select ${getCategoryLabel(currentLang, finding.category)} finding`);
      checkbox.addEventListener("change", () => {
        checkbox.setAttribute("aria-checked", checkbox.checked ? "true" : "false");
        const checked = [...list.querySelectorAll("input[type='checkbox']:checked")].map(
          (c) => (c as HTMLInputElement).value
        );
        void sendMessage({ type: "POPUP_APPLY_MASKS", requestId: requestId(), findingIds: checked });
      });
      check = checkbox;
    }

    const main = el("div", "finding__main");
    const head = el("div", "finding__head");
    const category = el("div", "finding__category", getCategoryLabel(currentLang, finding.category));
    head.append(category);
    if (reportOnly) {
      const attrBadge = el(
        "span",
        "finding__badge-attr",
        `Attribute${finding.attribute ? ` · ${finding.attribute}` : ""} — report only`
      );
      head.append(attrBadge);
    } else {
      const severity = el("span", "finding__severity", confidenceLabel(finding.confidence));
      severity.dataset.level = confidenceLabel(finding.confidence).toLowerCase();
      head.append(severity);
    }
    const preview = el("div", "finding__preview", finding.preview);
    const meta = el("div", "finding__meta");
    const confidence = el("span", "finding__confidence", `${Math.round(finding.confidence * 100)}% confidence`);
    meta.append(confidence);
    main.append(head, preview, meta);

    if (check) item.append(check, main);
    else {
      main.style.paddingLeft = "0";
      item.append(main);
    }
    list.appendChild(item);
  }
  if (selected > 0) {
    applyBtn.textContent = `${t(currentLang, "apply_masks_btn")} (${selected})`;
  } else {
    applyBtn.textContent = t(currentLang, "apply_masks_btn");
  }
}

/**
 * Offer the page's images to the Document Studio when a scan read no text.
 *
 * A page that is an image has nothing to scan, and the honest report is
 * "nothing to read" - but that alone is a dead end, because the document the
 * user cares about is right there in pixels and OCR already exists. Each image
 * becomes a button that hands the file to the studio, where the ordinary
 * review, redaction and download flow applies unchanged.
 *
 * The colour states the honest limit: green means the original file will be
 * read at full resolution, amber means only a rendered capture is possible, so
 * what is scanned is bounded by the viewport and the current zoom. A user
 * redactioning a scan needs to know which one they are getting.
 */
function renderImageCapture(candidates: ImageCandidate[] | undefined): void {
  const panel = document.getElementById("image-capture") as HTMLElement | null;
  const options = document.getElementById("image-capture-options") as HTMLElement | null;
  if (!panel || !options) return;
  if (!candidates || candidates.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  options.textContent = "";
  for (const candidate of candidates) {
    // A same-origin image can be read directly. A cross-origin one cannot,
    // because the extension holds no host permissions, so it falls back to
    // capturing the page - and the button says so rather than implying the
    // original is being read.
    const fullResolution = candidate.sameOrigin;
    const button = document.createElement("button");
    button.type = "button";
    // Assigned rather than templated: the DOM contract test discovers
    // runtime-created classes by scanning this file for literals, and a
    // template literal hides the two variants from it.
    const qualityClass = fullResolution ? "image-capture__btn--ok" : "image-capture__btn--warn";
    button.className = "image-capture__btn " + qualityClass;
    button.setAttribute(
      "aria-label",
      `${t(currentLang, fullResolution ? "image_capture_full" : "image_capture_screen")}: ${candidate.width}x${candidate.height}`
    );

    const badge = document.createElement("span");
    badge.className = "image-capture__badge";
    badge.textContent = t(currentLang, fullResolution ? "image_capture_full" : "image_capture_screen");

    const size = document.createElement("span");
    size.className = "image-capture__size";
    size.textContent = `${candidate.width}x${candidate.height}`;

    button.append(badge, size);
    if (!fullResolution) {
      const note = document.createElement("span");
      note.className = "footnote";
      note.textContent = t(currentLang, "image_capture_capture_note");
      button.append(note);
    }
    button.addEventListener("click", () => {
      void startImageCapture(candidate);
    });
    options.append(button);
  }
}

async function startImageCapture(candidate: ImageCandidate): Promise<void> {
  // Capture opens the Document Studio, so the panel and any scan results are
  // cleared first: leaving a "0 findings, scan complete" summary above a
  // document under review would be exactly the confusing overlap this feature
  // exists to remove.
  clearDocUi();
  setDocStatus(t(currentLang, "doc_processing"), false);
  showDocProgress();
  lastState = null;
  renderState(clearScanStateForCapture());
  try {
    await sendDocMessage({
      type: "POPUP_DOC_CAPTURE_IMAGE",
      requestId: requestId(),
      src: candidate.src,
      name: "page-image.png",
    });
  } catch {
    // sendDocMessage has already surfaced the failure in the status line.
  }
}

/** Reset the scan surface so a capture starts from a clean, honest state. */
function clearScanStateForCapture(): PopupState {
  return {
    mode: lastState?.mode ?? "local",
    scanning: false,
    findings: [],
    scanned: false,
    truncated: false,
    visibleChars: 0,
    consentRequired: false,
  };
}

/** True when a completed scan read no text, which is the only case that offers capture. */
function nothingToReadOrAbsent(state: PopupState): boolean {
  return !state.scanned || state.visibleChars === 0;
}

function renderState(state: PopupState): void {
  const badge = document.getElementById("mode-badge") as HTMLSpanElement | null;
  const status = document.getElementById("status") as HTMLParagraphElement | null;
  const scanBtn = document.getElementById("scan-btn") as HTMLButtonElement | null;
  const resultsSection = document.getElementById("results-section") as HTMLElement | null;
  const cloudNotice = document.getElementById("cloud-notice") as HTMLParagraphElement | null;
  const summary = document.getElementById("scan-summary") as HTMLElement | null;
  const summaryChars = document.getElementById("summary-chars") as HTMLElement | null;

  if (badge) {
    badge.textContent = state.mode === "cloud" ? t(currentLang, "cloud_processing") : t(currentLang, "local_processing");
    badge.classList.toggle("badge--cloud", state.mode === "cloud");
  }
  if (scanBtn) {
    scanBtn.disabled = state.scanning;
    scanBtn.textContent = state.scanning ? t(currentLang, "scanning_btn") : t(currentLang, "scan_page_btn");
  }

  if (summary && status && summaryChars) {
    summary.hidden = !(state.scanning || state.scanned || Boolean(state.error));
    if (state.error) {
      status.textContent = state.error.userMessage;
      status.classList.add("status--error");
      summaryChars.textContent = "";
    } else if (state.scanning) {
      status.textContent = t(currentLang, "status_scanning_text");
      status.classList.remove("status--error");
      summaryChars.textContent = "";
    } else if (state.scanned) {
      summaryChars.textContent = t(currentLang, "status_chars_analyzed", { count: state.visibleChars.toLocaleString() });
      // A scan that examined no text at all must not be reported as a success.
      // The overwhelmingly common cause is a page that *is* an image - a
      // letterhead scan, a rendered PDF, a screenshot - where the only text on
      // the page is inside pixels, so textContent is legitimately empty. Saying
      // "Completed securely on-device" there reads as a clean bill of health for
      // a document full of PII, and the user has no way to guess that "0
      // characters" means "nothing was checked". Point them at OCR instead.
      const nothingToRead = state.visibleChars === 0;
      status.textContent = nothingToRead
        ? t(currentLang, "status_no_text_found")
        : state.truncated
          ? t(currentLang, "status_partial_results")
          : t(currentLang, "status_completed_securely");
      status.classList.toggle("status--error", nothingToRead);
    } else {
      status.textContent = "";
      status.classList.remove("status--error");
    }
    // The offer only makes sense when there is genuinely nothing to read and
    // the page actually has an image worth lifting. A page with real text keeps
    // its normal results and no capture panel.
    renderImageCapture(nothingToReadOrAbsent(state) ? state.imageCandidates : undefined);
  } else {
    // The summary itself is collapsed (clearing a session, or a capture handing
    // over to the Document Studio), so the capture panel must go with it rather
    // than lingering with stale dimensions.
    renderImageCapture(undefined);
  }

  if (resultsSection) {
    resultsSection.hidden = !state.scanned;
    if (state.scanned) renderFindings(state.findings);
  }

  if (cloudNotice) {
    cloudNotice.hidden = state.mode !== "cloud" || !state.consentRequired;
    if (!cloudNotice.hidden) {
      cloudNotice.textContent = t(currentLang, "cloud_notice_text");
    }
  }

  const localRadio = document.getElementById("mode-local") as HTMLInputElement | null;
  const cloudRadio = document.getElementById("mode-cloud") as HTMLInputElement | null;
  if (localRadio && localRadio.checked !== (state.mode === "local")) localRadio.checked = state.mode === "local";
  if (cloudRadio && cloudRadio.checked !== (state.mode === "cloud")) cloudRadio.checked = state.mode === "cloud";
}

async function sendMessage(message: PopupMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
  }

/**
 * Send a Document Studio message and surface anything the worker refuses.
 *
 * The worker answers with `{ ok: false, error }` for a dispatch failure - a
 * rejected sender, a message that failed validation, or a failed local-storage
 * purge. Every document call site fired and forgot the reply, so those failures
 * reached the user as no feedback at all: the popup sat on "Scanning document
 * on this device." forever with nothing to indicate the request was refused.
 */
async function sendDocMessage(message: PopupMessage): Promise<void> {
  try {
    const response = (await sendMessage(message)) as { ok?: boolean; error?: unknown } | undefined;
    if (response && response.ok === false) {
      hideDocProgress();
      setDocStatus(typeof response.error === "string" ? response.error : "The document could not be processed.", true);
    }
  } catch (error) {
    hideDocProgress();
    setDocStatus(error instanceof Error ? error.message : "The document could not be processed.", true);
  }
}

function currentSelectedIds(state: PopupState): string[] {
  return state.findings.filter((f) => f.selected).map((f) => f.id);
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("clipboard unavailable");
  }
}

function findingsToCsv(findings: Finding[]): string {
  const headers = ["Category", "Preview", "Confidence", "Source", "Attribute", "Page", "Start Offset", "End Offset", "Rect Count"];
  const rows = findings.map((f) => {
    const pageMatch = f.nodeId.match(/^doc:(\d+):/);
    const page = pageMatch ? parseInt(pageMatch[1], 10) + 1 : "N/A";
    return [
      getCategoryLabel(currentLang, f.category),
      `"${f.preview.replace(/"/g, '""')}"`,
      `${Math.round(f.confidence * 100)}%`,
      f.source,
      f.attribute ? `"${f.attribute}"` : "",
      page.toString(),
      f.startOffset.toString(),
      f.endOffset.toString(),
      f.rects.length.toString(),
    ];
  });
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function findingsToJson(findings: Finding[]): string {
  const exportData = {
    exportedAt: new Date().toISOString(),
    totalFindings: findings.length,
    findings: findings.map((f) => ({
      id: f.id,
      category: f.category,
      categoryLabel: getCategoryLabel(currentLang, f.category),
      confidence: f.confidence,
      source: f.source,
      attribute: f.attribute ?? null,
      preview: f.preview,
      nodeId: f.nodeId,
      startOffset: f.startOffset,
      endOffset: f.endOffset,
      rectCount: f.rects.length,
      contextPreview: f.contextPreview ?? null,
    })),
  };
  return JSON.stringify(exportData, null, 2);
}

async function exportFindings(findings: Finding[], format: "csv" | "json"): Promise<void> {
  const content = format === "csv" ? findingsToCsv(findings) : findingsToJson(findings);
  const mimeType = format === "csv" ? "text/csv" : "application/json";
  const extension = format === "csv" ? "csv" : "json";
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `governworld-findings-${new Date().toISOString().split("T")[0]}.${extension}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface DocUiState {
  docId: string;
  fileKey: string;
  name: string;
  mimeType: string;
  kind: DocKind;
  pages: DocPageMeta[];
  /**
   * True when the bytes came from a screen capture rather than the original
   * file, so OCR quality is bounded by the on-screen size. Carried into the
   * review surface so it can say so instead of implying a full read.
   */
  degraded?: boolean;
  source?: "original" | "capture";
}

function detectDocKind(file: File, bytes: ArrayBuffer): DocKind {
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  const header = new Uint8Array(bytes.slice(0, 12));
  const startsWith = (...signature: number[]) => signature.every((value, index) => header[index] === value);
  if (name.endsWith(".pdf") || mime === "application/pdf") {
    if (!name.endsWith(".pdf") || (mime && mime !== "application/pdf") || !startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) throw new Error("Invalid PDF file.");
    return "pdf";
  }
  if (name.endsWith(".docx") || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    if (!name.endsWith(".docx") || (mime && mime !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") || !startsWith(0x50, 0x4b, 0x03, 0x04)) throw new Error("Invalid DOCX file.");
    return "docx";
  }
  const isPng = startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const isJpeg = startsWith(0xff, 0xd8, 0xff);
  const isWebp = startsWith(0x52, 0x49, 0x46, 0x46) && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50;
  if (isPng || isJpeg || isWebp) return "image";
  throw new Error("Unsupported file type.");
}

let lastDoc: DocUiState | null = null;
const selectedDocFindingIds = new Set<string>();
let currentStudioTool: "draw" | "erase" = "draw";

/**
 * Write a document-studio status line and reveal it.
 *
 * The message goes into `#doc-status-text` (the `<p>` the markup provides);
 * writing it to the `#doc-status` wrapper instead left the paragraph empty.
 * The wrapper ships with `hidden`, and nothing used to lift it, so every
 * status and every failure - including "no sensitive values were found" - was
 * rendered into a display:none element. An empty message hides the block again
 * so a stale "Scanning document on this device." does not outlive the run.
 */
function setDocStatus(message: string, isError: boolean): void {
  const status = document.getElementById("doc-status") as HTMLElement | null;
  if (!status) return;
  const text = document.getElementById("doc-status-text") as HTMLElement | null;
  if (text) {
    text.textContent = message;
  } else {
    status.textContent = message;
  }
  // The child sets its own colour, so the error colour has to reach it too.
  status.classList.toggle("status--error", isError);
  text?.classList.toggle("status--error", isError);
  status.hidden = message.length === 0;
}

/**
 * Hand the current document to the full-screen review page.
 *
 * The session is written to `chrome.storage.session` rather than sent as a
 * message, for the same reason document bytes never travel in one: the page
 * metadata for a long document is far larger than a runtime message may be.
 * The review page reads the store directly, exactly as redact.html reads
 * redacted pages.
 */
async function openFullScreenReview(
  doc: DocUiState,
  degraded: boolean,
  source: "original" | "capture"
): Promise<void> {
  const record = {
    docId: doc.docId,
    fileKey: doc.fileKey,
    name: doc.name,
    mimeType: doc.mimeType,
    kind: doc.kind,
    pages: doc.pages,
    degraded,
    source,
  };
  try {
    await chrome.storage.session.set({ reviewSession: record });
  } catch (error) {
    setDocStatus(
      error instanceof Error ? error.message : "The document could not be opened for review.",
      true
    );
    return;
  }
  const url = chrome.runtime.getURL("review.html");
  let opened = false;
  try {
    await chrome.tabs.create({ url, active: true });
    opened = true;
  } catch {
    opened = false;
  }
  if (!opened) {
    setDocStatus("Review could not be opened in a tab.", true);
  }
}

/** Reveal the Document Studio progress row for work that is actually running. */
function showDocProgress(): void {
  const progress = document.getElementById("doc-progress") as HTMLDivElement | null;
  if (progress) progress.hidden = false;
}

/** Hide the progress row once a run has finished, failed, or been cancelled. */
function hideDocProgress(): void {
  const progress = document.getElementById("doc-progress") as HTMLDivElement | null;
  if (progress) progress.hidden = true;
}

function renderDocStage(message: Extract<PopupFromWorker, { type: "POPUP_DOC_STATUS" }>): void {
  const progress = document.getElementById("doc-progress") as HTMLDivElement | null;
  const progressText = document.getElementById("doc-progress-text") as HTMLSpanElement | null;
  if (!progress) return;

  if (message.problem) {
    setDocStatus(message.problem, true);
    return;
  }

  progress.hidden = false;
  if (!progressText) return;
  if (message.stage === "detected") {
    progressText.textContent = t(currentLang, "doc_processing");
  } else if (message.stage === "redacted") {
    progressText.textContent =
      typeof message.paintedRegions === "number"
        ? `${message.paintedRegions} region${message.paintedRegions === 1 ? "" : "s"} blacked out`
        : "";
  } else {
    const verified = message.verifiedRegions ?? 0;
    const checked = message.checkedRegions ?? 0;
    const how = message.method === "page-pixels" ? "page bitmaps" : "the saved file";
    progressText.textContent = checked > 0 ? `${verified} of ${checked} regions confirmed in ${how}` : "";
  }
}

function resetDocStages(): void {
  const progress = document.getElementById("doc-progress") as HTMLDivElement | null;
  const progressText = document.getElementById("doc-progress-text") as HTMLSpanElement | null;
  if (progress) progress.hidden = true;
  if (progressText) progressText.textContent = t(currentLang, "doc_processing");
}

const overlayRedrawers: (() => void)[] = [];

export function redrawAllOverlays(): void {
  for (const redraw of overlayRedrawers) {
    try {
      redraw();
    } catch {
      // Ignored
    }
  }
}

function updateDocRedactBtn(): void {
  const redactBtn = document.getElementById("doc-redact-btn") as HTMLButtonElement | null;
  if (redactBtn) {
    redactBtn.disabled = selectedDocFindingIds.size === 0;
  }
}

function renderDocFindings(): void {
  const list = document.getElementById("doc-findings") as HTMLUListElement | null;
  const countBadge = document.getElementById("doc-findings-count") as HTMLSpanElement | null;
  if (!list) return;
  list.replaceChildren();
  if (!lastDoc) {
    if (countBadge) countBadge.textContent = "0";
    updateDocRedactBtn();
    return;
  }
  const totalFindings = lastDoc.pages.reduce((n, p) => n + p.findings.length, 0);
  if (countBadge) countBadge.textContent = `${totalFindings} detected`;

  for (const page of lastDoc.pages) {
    for (const finding of page.findings) {
      const item = el("li", "finding");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "finding__check";
      check.checked = selectedDocFindingIds.has(finding.id);
      check.setAttribute("aria-checked", check.checked ? "true" : "false");
      check.setAttribute("aria-label", `Select ${getCategoryLabel(currentLang, finding.category)} finding on page ${page.index + 1}`);
      check.addEventListener("change", () => {
        check.setAttribute("aria-checked", check.checked ? "true" : "false");
        if (check.checked) selectedDocFindingIds.add(finding.id);
        else selectedDocFindingIds.delete(finding.id);
        updateDocRedactBtn();
        redrawAllOverlays();
      });

      const main = el("div", "finding__main");
      const head = el("div", "finding__head");
      const category = el("div", "finding__category", getCategoryLabel(currentLang, finding.category));
      head.append(category);
      if (finding.category === "custom") {
        const customBadge = el("span", "finding__badge-attr", "Drawn Box");
        head.append(customBadge);
      }
      const preview = el("div", "finding__preview", finding.preview);
      const meta = el("div", "finding__meta");
      const confidence = el("div", "finding__confidence", `${confidenceLabel(finding.confidence)} (${Math.round(finding.confidence * 100)}%)`);
      meta.append(confidence);
      main.append(head, preview, meta);

      const context = el("div", "finding__context", `Page ${page.index + 1} — ${finding.contextPreview ?? ""}`);
      item.append(check, main, context);
      list.appendChild(item);
    }
  }
  updateDocRedactBtn();
}

/**
 * Open a document session as soon as a preview is requested.
 *
 * The POPUP_DOC_STATE handler drops the first reply unless `lastDoc` already
 * describes the same document, and `lastDoc` was otherwise only ever assigned
 * inside `renderDoc` — which that same handler is the only caller of. Without
 * this, the guard could never be satisfied, so selecting a document left the
 * popup waiting on "Scanning document on this device…" with the Document Studio
 * never appearing. The worker assigns the real `docId` in its reply, which the
 * handler then copies in; the placeholder is matched on `fileKey`.
 */
function beginDocSession(seed: {
  fileKey: string;
  name: string;
  mimeType: string;
  kind: DocKind;
}): void {
  lastDoc = {
    docId: "",
    fileKey: seed.fileKey,
    name: seed.name,
    mimeType: seed.mimeType,
    kind: seed.kind,
    pages: [],
  };
  selectedDocFindingIds.clear();
  overlayRedrawers.length = 0;
}

/**
 * Point a page thumbnail at its persisted preview bitmap.
 *
 * The rendered page image is stored in the shared document store and referenced
 * by key, because a base64 page preview is far larger than a runtime message may
 * be. A missing preview degrades to alt text rather than breaking the studio.
 */
async function loadPreviewInto(img: HTMLImageElement, page: DocPageMeta): Promise<void> {
  try {
    const url = await previewObjectUrl(page.previewKey);
    if (url) {
      img.src = url;
      return;
    }
  } catch {
    // Fall through to the degraded state below.
  }
  img.alt = `Page ${page.index + 1} (preview unavailable)`;
}

function renderDoc(state: DocUiState): void {
  lastDoc = state;
  selectedDocFindingIds.clear();
  overlayRedrawers.length = 0;
  for (const page of state.pages) {
    for (const finding of page.findings) {
      if (finding.selected !== false) {
        selectedDocFindingIds.add(finding.id);
      }
    }
  }

  const workspace = document.getElementById("doc-workspace") as HTMLElement | null;
  const thumbs = document.getElementById("doc-thumbs") as HTMLElement | null;
  const docFilename = document.getElementById("doc-filename") as HTMLElement | null;
  const docPageCount = document.getElementById("doc-page-count") as HTMLElement | null;
  const docStyleSelect = document.getElementById("doc-style-select") as HTMLSelectElement | null;
  const docStampText = document.getElementById("doc-stamp-text") as HTMLInputElement | null;

  if (docFilename) docFilename.textContent = state.name;
  if (docPageCount) docPageCount.textContent = `${state.pages.length} page${state.pages.length === 1 ? "" : "s"}`;
  if (workspace) workspace.hidden = false;

  if (thumbs) {
    thumbs.replaceChildren();
    for (const page of state.pages) {
      const wrapper = el("div", "doc-thumb-wrapper");
      wrapper.setAttribute("title", "Click a finding to toggle, or drag to draw a custom redaction box");

      const img = document.createElement("img");
      img.alt = `Page ${page.index + 1}`;
      img.loading = "lazy";
      // The preview image is not carried in the message; it is persisted in the
      // shared document store and referenced by key, so it resolves asynchronously.
      void loadPreviewInto(img, page);

      const canvas = document.createElement("canvas");
      canvas.className = "doc-thumb-canvas";
      canvas.width = page.widthPx;
      canvas.height = page.heightPx;

      const redraw = () => {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const style = (docStyleSelect?.value as RedactionStyle) || "blackout";
        const stampLabel = docStampText?.value?.trim() || "[REDACTED]";

        for (const finding of page.findings) {
          if (!selectedDocFindingIds.has(finding.id)) continue;
          for (const rect of finding.rects) {
            if (style === "blackout") {
              ctx.fillStyle = "#000000";
              ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
            } else if (style === "whiteout") {
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
              ctx.strokeStyle = "#cccccc";
              ctx.lineWidth = 1;
              ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
            } else if (style === "stamp") {
              ctx.fillStyle = "#000000";
              ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
              ctx.fillStyle = "#ffffff";
              const fontSize = Math.max(10, Math.min(rect.height * 0.7, 16));
              ctx.font = `bold ${fontSize}px sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillText(stampLabel, rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width - 4);
            }
          }
        }
      };

      overlayRedrawers.push(redraw);
      redraw();

      let isDrawing = false;
      let startX = 0;
      let startY = 0;

      const getCoords = (e: MouseEvent) => {
        const bounds = canvas.getBoundingClientRect();
        const scaleX = canvas.width / bounds.width;
        const scaleY = canvas.height / bounds.height;
        return {
          x: Math.round((e.clientX - bounds.left) * scaleX),
          y: Math.round((e.clientY - bounds.top) * scaleY),
        };
      };

      canvas.addEventListener("mousedown", (e) => {
        if (currentStudioTool === "draw") {
          isDrawing = true;
          const { x, y } = getCoords(e);
          startX = x;
          startY = y;
        }
      });

      canvas.addEventListener("mousemove", (e) => {
        if (!isDrawing) return;
        const { x, y } = getCoords(e);
        redraw();
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.strokeStyle = "#00ffff";
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 2]);
          ctx.strokeRect(
            Math.min(startX, x),
            Math.min(startY, y),
            Math.abs(x - startX),
            Math.abs(y - startY)
          );
          ctx.setLineDash([]);
        }
      });

      const finishDraw = (e: MouseEvent) => {
        if (!isDrawing) return;
        isDrawing = false;
        const { x, y } = getCoords(e);
        const rx = Math.min(startX, x);
        const ry = Math.min(startY, y);
        const rw = Math.abs(x - startX);
        const rh = Math.abs(y - startY);

        if (rw < 8 || rh < 8) {
          const clickedFinding = page.findings.find((f) =>
            f.rects.some((r) => rx >= r.x && rx <= r.x + r.width && ry >= r.y && ry <= r.y + r.height)
          );
          if (clickedFinding) {
            if (selectedDocFindingIds.has(clickedFinding.id)) {
              selectedDocFindingIds.delete(clickedFinding.id);
            } else {
              selectedDocFindingIds.add(clickedFinding.id);
            }
            renderDocFindings();
            redrawAllOverlays();
          }
          return;
        }

        const customFinding: Finding = {
          id: requestId(),
          category: "custom",
          confidence: 1.0,
          source: "local-rules",
          preview: `Custom Area (${rw}x${rh})`,
          nodeId: `doc:${page.index}:custom`,
          startOffset: 0,
          endOffset: 0,
          rects: [{ x: rx, y: ry, width: rw, height: rh }],
          selected: true,
        };

        page.findings.push(customFinding);
        selectedDocFindingIds.add(customFinding.id);
        renderDocFindings();
        redrawAllOverlays();
      };

      canvas.addEventListener("mouseup", finishDraw);
      canvas.addEventListener("mouseleave", () => {
        if (isDrawing) {
          isDrawing = false;
          redraw();
        }
      });

      wrapper.append(img, canvas);
      thumbs.appendChild(wrapper);
    }
  }

  renderDocFindings();
}

function buildDocBoxes(): { pageIndex: number; rects: Rect[] }[] {
  if (!lastDoc) return [];
  const byId = new Map<string, { pageIndex: number; rects: Rect[] }>();
  for (const page of lastDoc.pages) {
    for (const finding of page.findings) {
      if (!selectedDocFindingIds.has(finding.id)) continue;
      const entry = byId.get(finding.id) ?? { pageIndex: page.index, rects: [] };
      entry.rects.push(...finding.rects);
      byId.set(finding.id, entry);
    }
  }
  return [...byId.values()];
}

function clearDocUi(): void {
  const workspace = document.getElementById("doc-workspace") as HTMLElement | null;
  const thumbs = document.getElementById("doc-thumbs") as HTMLElement | null;
  const list = document.getElementById("doc-findings") as HTMLUListElement | null;
  const redactBtn = document.getElementById("doc-redact-btn") as HTMLButtonElement | null;
  if (lastDoc) void deleteFile(lastDoc.fileKey).catch(() => undefined);
  lastDoc = null;
  selectedDocFindingIds.clear();
  overlayRedrawers.length = 0;
  if (workspace) workspace.hidden = true;
  if (thumbs) thumbs.replaceChildren();
  if (list) list.replaceChildren();
  if (redactBtn) redactBtn.disabled = true;
}

/** Wire tab navigation and contextual guidance links. */
function initTabs(): void {
  const tabButtons = document.querySelectorAll<HTMLButtonElement>(".tab-btn");
  const tabPanels = document.querySelectorAll<HTMLElement>(".tab-panel");

  function switchTab(tabId: string): void {
    tabButtons.forEach((btn) => {
      const isActive = btn.dataset.tab === tabId;
      btn.classList.toggle("tab-btn--active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    tabPanels.forEach((panel) => {
      const isActive = panel.id === `tab-${tabId}`;
      panel.hidden = !isActive;
      panel.classList.toggle("tab-panel--active", isActive);
    });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      if (tabId) switchTab(tabId);
    });
  });

  const settingsGear = document.getElementById("settings-gear-btn");
  settingsGear?.addEventListener("click", () => switchTab("settings"));

  const helpLinks = document.querySelectorAll<HTMLElement>("[data-guide]");
  helpLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const guideId = link.getAttribute("data-guide");
      if (!guideId) return;
      switchTab("settings");
      // Guide cards live in the About sub-page, which is hidden by default.
      switchSettingsPage("about");
      const targetEl = document.getElementById(guideId);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
        targetEl.classList.remove("guide-card--highlight");
        void targetEl.offsetWidth;
        targetEl.classList.add("guide-card--highlight");
      }
    });
  });

  const settingsNavBtns = document.querySelectorAll<HTMLButtonElement>(".settings-nav-btn");
  const settingsPages = document.querySelectorAll<HTMLElement>(".settings-page");

  function switchSettingsPage(pageId: string): void {
    settingsNavBtns.forEach((btn) => {
      const isActive = btn.dataset.settingsPage === pageId;
      btn.classList.toggle("settings-nav-btn--active", isActive);
      if (isActive) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    settingsPages.forEach((page) => {
      const isActive = page.dataset.settingsPage === pageId;
      page.hidden = !isActive;
      page.classList.toggle("settings-page--active", isActive);
    });
  }

  switchSettingsPage("profile");

  settingsNavBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const pageId = btn.dataset.settingsPage;
      if (pageId) switchSettingsPage(pageId);
    });
  });

  const openDocBtn = document.getElementById("open-doc-btn");
  openDocBtn?.addEventListener("click", () => {
    const dropzone = document.getElementById("doc-dropzone");
    if (dropzone) {
      const fileInput = document.getElementById("doc-file-input") as HTMLInputElement | null;
      fileInput?.click();
    }
  });

  const openWizardBtn2 = document.getElementById("open-wizard-btn-2");
  openWizardBtn2?.addEventListener("click", () => {
    const wizardBtn = document.getElementById("open-wizard-btn") as HTMLButtonElement | null;
    wizardBtn?.click();
  });

  const coverageDetailsBtn = document.getElementById("coverage-details-btn");
  coverageDetailsBtn?.addEventListener("click", () => {
    switchSettingsPage("privacy");
  });
}

export interface ProtectionStatusSnapshot {
  settings: Settings;
  policy: import("../shared/enterprisePolicy.js").EnterprisePolicy;
  effective: EffectiveProtection;
  capability: AlwaysOnCapability;
}

/** Load the full protection picture: user settings, admin policy, site access. */
export async function loadProtectionStatus(): Promise<ProtectionStatusSnapshot> {
  const [settings, policy, capability] = await Promise.all([
    loadSettings(),
    loadEnterprisePolicy(),
    queryAlwaysOnCapability(),
  ]);
  return { settings, policy, effective: resolveEffectiveProtection(settings, policy), capability };
}

/** Request optional site access for always-on. False when denied or unavailable. */
export async function requestSiteAccess(): Promise<boolean> {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions?.request) return false;
    return await chrome.permissions.request({ origins: [...ALWAYS_ON_ORIGINS] });
  } catch {
    return false;
  }
}

function setModeToggle(el: HTMLInputElement | null, checked: boolean, disabled: boolean): void {
  if (!el) return;
  el.checked = checked;
  el.setAttribute("aria-checked", checked ? "true" : "false");
  el.disabled = disabled;
}

/**
 * Render the honest protection state across the popup and side panel (they
 * share this controller). The banner names the verified mode: "always on"
 * appears ONLY with proof (registration possible AND site access granted);
 * otherwise it names the missing piece. A locked enterprise policy disables
 * the mode controls so no toggle can override it.
 */
export async function refreshProtectionStatus(): Promise<ProtectionStatusSnapshot> {
  const snapshot = await loadProtectionStatus();
  const { settings, policy, effective, capability } = snapshot;
  const lang = settings.language;
  const state = describeProtectionState(effective.mode, capability);

  const stateKey =
    state === "off"
      ? "protection_state_off"
      : state === "always-on-active"
        ? "protection_state_always_on"
        : state === "always-on-waiting-access"
          ? "protection_state_waiting"
          : "protection_state_this_tab";

  const banner = document.getElementById("scanner-shield-status");
  const label = document.getElementById("scanner-shield-label");
  if (label) label.textContent = t(lang, stateKey);
  if (banner) {
    banner.classList.toggle("shield-banner--inactive", state === "off" || state === "always-on-waiting-access");
  }

  const stateLine = document.getElementById("protection-state");
  if (stateLine) stateLine.textContent = t(lang, stateKey);

  const managedNotice = document.getElementById("managed-lock-notice");
  if (managedNotice) {
    managedNotice.hidden = !effective.locked;
    if (effective.locked) managedNotice.textContent = t(lang, "managed_lock_notice");
  }

  setModeToggle(
    document.getElementById("paste-guard-toggle") as HTMLInputElement | null,
    effective.mode !== "off",
    effective.locked
  );
  setModeToggle(
    document.getElementById("always-on-toggle") as HTMLInputElement | null,
    effective.mode === "always-on",
    effective.locked
  );

  const grantBtn = document.getElementById("grant-access-btn") as HTMLButtonElement | null;
  if (grantBtn) {
    grantBtn.hidden = effective.mode !== "always-on" || capability.siteAccessGranted;
  }

  await renderCategories({
    enabledCategories: effective.enabledCategories,
    lockedCategories: effective.lockedCategories,
    language: lang,
  });
  return snapshot;
}

/** Shared popup/panel bootstrap. */
export async function initPopup(): Promise<void> {
  initTabs();

  const settings = await loadSettings();
  currentLang = settings.language;
  applyUiLanguage(settings.language);
  applyAccessibilitySettings(settings);
  await refreshProtectionStatus();

  const scanBtn = document.getElementById("scan-btn") as HTMLButtonElement | null;
  const clearDataBtn = document.getElementById("clear-data-btn") as HTMLButtonElement | null;
  const applyMasksBtn = document.getElementById("apply-masks-btn") as HTMLButtonElement | null;
  const removeMasksBtn = document.getElementById("remove-masks-btn") as HTMLButtonElement | null;
  const copyRedactedBtn = document.getElementById("copy-redacted-btn") as HTMLButtonElement | null;
  const copyDialog = document.getElementById("copy-dialog") as HTMLDialogElement | null;
  const copyCancel = document.getElementById("copy-cancel") as HTMLButtonElement | null;
  const copyConfirm = document.getElementById("copy-confirm") as HTMLButtonElement | null;
  const localRadio = document.getElementById("mode-local") as HTMLInputElement | null;
  const cloudRadio = document.getElementById("mode-cloud") as HTMLInputElement | null;

  const privacyLink = document.getElementById("privacy-link") as HTMLAnchorElement | null;
  if (privacyLink) {
    const privacyUrl = chrome.runtime.getURL("privacy.html");
    privacyLink.href = privacyUrl;
    privacyLink.target = "_blank";
    privacyLink.rel = "noopener noreferrer";
  }

  const termsLink = document.getElementById("terms-link") as HTMLAnchorElement | null;
  if (termsLink) {
    const termsUrl = chrome.runtime.getURL("legal.html");
    termsLink.href = termsUrl;
    termsLink.target = "_blank";
    termsLink.rel = "noopener noreferrer";
  }

  const aboutPrivacyLink = document.getElementById("about-privacy-link") as HTMLAnchorElement | null;
  if (aboutPrivacyLink) {
    aboutPrivacyLink.href = chrome.runtime.getURL("privacy.html");
    aboutPrivacyLink.target = "_blank";
    aboutPrivacyLink.rel = "noopener noreferrer";
  }

  const docFile = document.getElementById("doc-file-input") as HTMLInputElement | null;
  const docRedactBtn = document.getElementById("doc-redact-btn") as HTMLButtonElement | null;
  const docOpenReviewBtn = document.getElementById("doc-open-review-btn") as HTMLButtonElement | null;
  const docClearBtn = document.getElementById("doc-clear-btn") as HTMLButtonElement | null;
  const docConfirmDialog = document.getElementById("doc-confirm-dialog") as HTMLDialogElement | null;
  const docCancel = document.getElementById("doc-cancel") as HTMLButtonElement | null;
  const docConfirm = document.getElementById("doc-confirm") as HTMLButtonElement | null;
  const printBar = document.getElementById("doc-print-bar") as HTMLElement | null;
  const docPrintBtn = document.getElementById("doc-print-btn") as HTMLButtonElement | null;

  /** Store key of the last verified redaction, if one is still staged. */
  let lastPrintFileKey: string | null = null;

  scanBtn?.addEventListener("click", async () => {
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "speech_scan_start"), current);
    const mode: ScanMode = lastState?.mode ?? current.mode;
    void sendMessage({ type: "POPUP_SCAN", requestId: requestId(), mode });
  });

  clearDataBtn?.addEventListener("click", async () => {
    void sendMessage({ type: "POPUP_CLEAR_DATA", requestId: requestId() });
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "speech_session_cleared"), current);
  });

  document.getElementById("open-side-panel-btn")?.addEventListener("click", async () => {
    try {
      if (typeof chrome !== "undefined" && chrome.sidePanel && typeof chrome.sidePanel.open === "function") {
        const windowId = (await chrome.windows.getCurrent()).id;
        if (windowId != null) {
          await chrome.sidePanel.open({ windowId });
          return;
        }
      }
      // Cross-browser fallback for Firefox/Safari/older Chromium without sidePanel API
      if (typeof chrome !== "undefined" && chrome.windows && typeof chrome.windows.create === "function") {
        await chrome.windows.create({
          url: chrome.runtime.getURL("sidepanel.html"),
          type: "popup",
          width: 440,
          height: 680,
        });
      } else if (typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.create === "function") {
        await chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") });
      }
    } catch {
      try {
        window.open(chrome.runtime.getURL("sidepanel.html"), "_blank");
      } catch {
        // Ignored
      }
    }
  });

  applyMasksBtn?.addEventListener("click", async () => {
    if (!lastState) return;
    const ids = currentSelectedIds(lastState);
    void sendMessage({ type: "POPUP_APPLY_MASKS", requestId: requestId(), findingIds: ids });
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "speech_masks_applied", { count: ids.length }), current);
    if (current.autoCopySanitized && ids.length > 0) {
      void sendMessage({ type: "POPUP_COPY_REDACTED", requestId: requestId(), findingIds: ids });
    }
  });

  removeMasksBtn?.addEventListener("click", async () => {
    void sendMessage({ type: "POPUP_REMOVE_MASKS", requestId: requestId() });
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "speech_masks_removed"), current);
  });

  document.getElementById("undo-masks-btn")?.addEventListener("click", () => {
    void sendMessage({ type: "POPUP_UNDO_MASKS", requestId: requestId() });
  });

  copyRedactedBtn?.addEventListener("click", () => {
    if (!lastState || currentSelectedIds(lastState).length === 0) return;
    copyDialog?.showModal();
  });

  copyCancel?.addEventListener("click", () => copyDialog?.close());
  copyConfirm?.addEventListener("click", async () => {
    copyDialog?.close();
    if (!lastState) return;
    const ids = currentSelectedIds(lastState);
    void sendMessage({ type: "POPUP_COPY_REDACTED", requestId: requestId(), findingIds: ids });
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "speech_copied_redacted"), current);
  });

  // Select / Deselect all findings in scanner
  const toggleAllFindingsBtn = document.getElementById("toggle-all-findings-btn") as HTMLButtonElement | null;
  toggleAllFindingsBtn?.addEventListener("click", () => {
    if (!lastState || lastState.findings.length === 0) return;
    const anyUnselected = lastState.findings.some((f) => !f.selected && f.source !== "attr");
    const findingIds = anyUnselected
      ? lastState.findings.filter((f) => f.source !== "attr").map((f) => f.id)
      : [];
    void sendMessage({ type: "POPUP_APPLY_MASKS", requestId: requestId(), findingIds });
  });

  const exportBtn = document.getElementById("export-findings-btn") as HTMLButtonElement | null;
  exportBtn?.addEventListener("click", async () => {
    if (!lastState || lastState.findings.length === 0) return;
    const format = window.confirm("Export as CSV? (Cancel for JSON)") ? "csv" : "json";
    await exportFindings(lastState.findings, format);
  });

  docFile?.addEventListener("change", async () => {
    const file = docFile.files?.[0];
    if (!file) return;
    if (file.size > MAX_DOC_BYTES) {
      setDocStatus("This file is too large (maximum 20 MB).", true);
      return;
    }
    const fileKey = requestId();
    try {
      const bytes = await file.arrayBuffer();
      const kind: DocKind = detectDocKind(file, bytes);
      const mimeType =
        file.type ||
        (kind === "pdf" ? "application/pdf" : kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "image/png");
      await storeFile(fileKey, bytes);
      docFile.value = "";
      resetDocStages();
      setDocStatus("Scanning document on this device…", false);
      // A preview takes 6-20s: offscreen document boot, then pdf.js or the
      // image decode, then a 10MB OCR model. resetDocStages() had just hidden
      // the progress row, and the status line was invisible, so the popup
      // showed no change at all for the whole wait and read as broken.
      showDocProgress();
      beginDocSession({ fileKey, name: file.name, mimeType, kind });
      void sendDocMessage({ type: "POPUP_DOC_PREVIEW", requestId: requestId(), fileKey, name: file.name, mimeType, kind });
    } catch (error) {
      await deleteFile(fileKey).catch(() => undefined);
      docFile.value = "";
      setDocStatus(error instanceof Error ? error.message : "Could not read this file.", true);
    }
  });

  // Document Style & OCR Language Selectors
  const docStyleSelect = document.getElementById("doc-style-select") as HTMLSelectElement | null;
  const docStampContainer = document.getElementById("doc-stamp-container") as HTMLDivElement | null;
  const docStampText = document.getElementById("doc-stamp-text") as HTMLInputElement | null;
  const docStampPresets = document.getElementById("doc-stamp-presets") as HTMLSelectElement | null;
  const docOcrLangSelect = document.getElementById("doc-ocr-language-select") as HTMLSelectElement | null;
  const ocrLangSelect = document.getElementById("ocr-language-select") as HTMLSelectElement | null;

  const syncOcrLanguage = async (val: string) => {
    if (ocrLangSelect && ocrLangSelect.value !== val) ocrLangSelect.value = val;
    if (docOcrLangSelect && docOcrLangSelect.value !== val) docOcrLangSelect.value = val;
    const current = await loadSettings();
    await saveSettings({ ...current, ocrLanguage: val });
  };

  // Populate the language selectors from the bundled set at runtime, and drop any
  // option whose data is not in the package. The markup used to list six
  // languages while only English was vendored, so selecting another one silently
  // ran English OCR. Deriving the list from BUNDLED_OCR_LANGUAGES means the
  // selector can never advertise a language the extension cannot read offline.
  for (const select of [ocrLangSelect, docOcrLangSelect]) {
    if (!select) continue;
    const currentValue = select.value;
    select.replaceChildren(
      ...BUNDLED_OCR_LANGUAGES.map((lang) => {
        const opt = document.createElement("option");
        opt.value = lang.code;
        opt.textContent = `${lang.label} (${lang.code})`;
        return opt;
      })
    );
    const wanted = settings.ocrLanguage || "eng";
    select.value = BUNDLED_OCR_LANGUAGES.some((l) => l.code === wanted) ? wanted : currentValue || "eng";
    select.addEventListener("change", () => void syncOcrLanguage(select.value));
  }

  if (docStyleSelect) {
    docStyleSelect.value = settings.defaultRedactionStyle || "blackout";
    docStyleSelect.addEventListener("change", () => {
      if (docStampContainer) {
        docStampContainer.hidden = docStyleSelect.value !== "stamp";
      }
      redrawAllOverlays();
    });
  }

  if (docStampPresets && docStampText) {
    docStampPresets.addEventListener("change", () => {
      docStampText.value = docStampPresets.value;
      redrawAllOverlays();
    });
  }

  if (docStampText) {
    docStampText.value = settings.defaultStampText || "[REDACTED]";
    docStampText.addEventListener("input", () => {
      redrawAllOverlays();
    });
  }

  // Document Studio Canvas Tools
  const toolDrawBox = document.getElementById("tool-draw-box") as HTMLButtonElement | null;
  const toolClearCustom = document.getElementById("tool-clear-custom") as HTMLButtonElement | null;
  const toolToggleAllDoc = document.getElementById("tool-toggle-all-doc") as HTMLButtonElement | null;

  toolDrawBox?.addEventListener("click", () => {
    currentStudioTool = "draw";
    toolDrawBox.classList.add("tool-btn--active");
  });

  toolClearCustom?.addEventListener("click", () => {
    if (!lastDoc) return;
    for (const page of lastDoc.pages) {
      page.findings = page.findings.filter((f) => {
        if (f.category === "custom") {
          selectedDocFindingIds.delete(f.id);
          return false;
        }
        return true;
      });
    }
    renderDocFindings();
    redrawAllOverlays();
  });

  toolToggleAllDoc?.addEventListener("click", () => {
    if (!lastDoc) return;
    const allFindings = lastDoc.pages.flatMap((p) => p.findings);
    const anyUnselected = allFindings.some((f) => !selectedDocFindingIds.has(f.id));
    if (anyUnselected) {
      for (const f of allFindings) selectedDocFindingIds.add(f.id);
    } else {
      selectedDocFindingIds.clear();
    }
    renderDocFindings();
    redrawAllOverlays();
  });

  docRedactBtn?.addEventListener("click", () => {
    if (!lastDoc || selectedDocFindingIds.size === 0) return;
    docConfirmDialog?.showModal();
  });

  docCancel?.addEventListener("click", () => docConfirmDialog?.close());

  // Opens the read-only print view in a tab. The button is only revealed after a
  // redaction reported a staged print handle, so there is always a document to
  // show; the guard here covers the case where the staged pages were since
  // cleared from the store.
  docPrintBtn?.addEventListener("click", () => {
    if (!lastPrintFileKey) return;
    void sendDocMessage({ type: "POPUP_DOC_PRINT", requestId: requestId(), fileKey: lastPrintFileKey });
  });

  // Opens the full-screen review surface.
  //
  // The studio in a 360px popup renders a page of text at roughly a tenth of
  // its natural size, so drawing a box over it means drawing blind, and the
  // thumbnail is too small to check the words at all. review.html shows the
  // document at full size with every control beside it. It is opened from a
  // click handler, which is the gesture a popup needs to open a tab at all.
  docOpenReviewBtn?.addEventListener("click", () => {
    if (!lastDoc || lastDoc.pages.length === 0) {
      setDocStatus("Preview the document first, then open review.", true);
      return;
    }
    void openFullScreenReview(lastDoc, lastDoc.degraded === true, lastDoc.source === "capture" ? "capture" : "original");
  });

  docConfirm?.addEventListener("click", async () => {
    docConfirmDialog?.close();
    if (!lastDoc) return;
    const boxes = buildDocBoxes();
    const ids = [...selectedDocFindingIds];
    if (boxes.length === 0) return;
    setDocStatus("Preparing redacted copy…", false);
    const current = await loadSettings();
    const style = (docStyleSelect?.value as RedactionStyle) || current.defaultRedactionStyle || "blackout";
    const stampText = docStampText?.value?.trim() || current.defaultStampText || "[REDACTED]";
    void sendDocMessage({
      type: "POPUP_DOC_REDACT",
      requestId: requestId(),
      docId: lastDoc.docId,
      fileKey: lastDoc.fileKey,
      name: lastDoc.name,
      mimeType: lastDoc.mimeType,
      kind: lastDoc.kind,
      boxes,
      findingIds: ids,
      options: {
        style,
        stampText,
        padding: current.maskPadding,
        fillColor: current.maskColor,
      },
    });
  });

  docClearBtn?.addEventListener("click", () => {
    if (!lastDoc) return;
    void sendDocMessage({ type: "POPUP_DOC_CLEAR", requestId: requestId(), docId: lastDoc.docId });
    clearDocUi();
    setDocStatus("", false);
  });

  const docCancelBtn = document.getElementById("doc-cancel-btn") as HTMLButtonElement | null;

  docCancelBtn?.addEventListener("click", () => {
    if (!lastDoc) return;
    void sendDocMessage({ type: "POPUP_DOC_CANCEL", requestId: requestId(), docId: lastDoc.docId });
    hideDocProgress();
    clearDocUi();
    setDocStatus("Document processing cancelled.", false);
  });

  const dropzone = document.getElementById("doc-dropzone") as HTMLDivElement | null;
  if (dropzone && docFile) {
    const handleDroppedFile = async (file: File): Promise<void> => {
      if (file.size > MAX_DOC_BYTES) {
        setDocStatus("This file is too large (maximum 20 MB).", true);
        return;
      }
      const fileKey = requestId();
      try {
        const bytes = await file.arrayBuffer();
        const kind: DocKind = detectDocKind(file, bytes);
        const mimeType =
          file.type ||
          (kind === "pdf" ? "application/pdf" : kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "image/png");
        await storeFile(fileKey, bytes);
        setDocStatus("Scanning document on this device…", false);
        showDocProgress();
        beginDocSession({ fileKey, name: file.name, mimeType, kind });
        void sendDocMessage({ type: "POPUP_DOC_PREVIEW", requestId: requestId(), fileKey, name: file.name, mimeType, kind });
      } catch (error) {
        await deleteFile(fileKey).catch(() => undefined);
        setDocStatus(error instanceof Error ? error.message : "Could not read this file.", true);
      }
    };
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("doc-dropzone--active");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("doc-dropzone--active");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("doc-dropzone--active");
      const file = e.dataTransfer?.files?.[0];
      if (file) void handleDroppedFile(file);
    });
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        docFile.click();
      }
    });
  }

  localRadio?.addEventListener("change", () => {
    void sendMessage({ type: "POPUP_SET_MODE", requestId: requestId(), mode: "local" });
  });
  cloudRadio?.addEventListener("change", () => {
    void sendMessage({ type: "POPUP_SET_MODE", requestId: requestId(), mode: "cloud" });
  });

  const presetSelect = document.getElementById("preset-select") as HTMLSelectElement | null;
  presetSelect?.addEventListener("change", async () => {
    const presetId = presetSelect.value as PresetId;
    await applyPreset(presetId);
  });

  // Category Filter Buttons
  document.getElementById("cat-filter-all")?.addEventListener("click", () => void applyCategoryFilter(ALL_CATEGORIES));
  document.getElementById("cat-filter-health")?.addEventListener("click", () => void applyCategoryFilter(HEALTHCARE_CATEGORIES));
  document.getElementById("cat-filter-intl")?.addEventListener("click", () => void applyCategoryFilter(INTERNATIONAL_CATEGORIES));
  document.getElementById("cat-filter-finance")?.addEventListener("click", () => void applyCategoryFilter(FINANCIAL_CATEGORIES));
  document.getElementById("cat-filter-none")?.addEventListener("click", () => void applyCategoryFilter([]));

  const placeholderToggle = document.getElementById("placeholder-toggle") as HTMLInputElement | null;
  if (placeholderToggle) {
    placeholderToggle.checked = settings.maskPlaceholders;
    placeholderToggle.setAttribute("aria-checked", placeholderToggle.checked ? "true" : "false");
    placeholderToggle.addEventListener("change", async () => {
      placeholderToggle.setAttribute("aria-checked", placeholderToggle.checked ? "true" : "false");
      const current = await loadSettings();
      await saveSettings({ ...current, maskPlaceholders: placeholderToggle.checked });
    });
  }

  const pasteGuardToggle = document.getElementById("paste-guard-toggle") as HTMLInputElement | null;
  const alwaysOnToggle = document.getElementById("always-on-toggle") as HTMLInputElement | null;
  const grantAccessBtn = document.getElementById("grant-access-btn") as HTMLButtonElement | null;

  /** Persist a user mode change; locked policies reject it before storage. */
  async function saveUserMode(mode: ProtectionMode): Promise<void> {
    const policy = await loadEnterprisePolicy();
    if (policy.managed && !policy.userCanDisable) return;
    const current = await loadSettings();
    await saveSettings({ ...current, protectionMode: mode, pasteGuardEnabled: mode !== "off" });
    await refreshProtectionStatus();
  }

  if (pasteGuardToggle) {
    pasteGuardToggle.addEventListener("change", async () => {
      if (pasteGuardToggle.disabled) {
        await refreshProtectionStatus();
        return;
      }
      if (!pasteGuardToggle.checked) {
        const alwaysOn = document.getElementById("always-on-toggle") as HTMLInputElement | null;
        if (alwaysOn) setModeToggle(alwaysOn, false, alwaysOn.disabled);
        await saveUserMode("off");
        return;
      }
      const wantAlwaysOn =
        (document.getElementById("always-on-toggle") as HTMLInputElement | null)?.checked === true;
      if (wantAlwaysOn) {
        const granted = await requestSiteAccess();
        await saveUserMode(granted ? "always-on" : "this-tab");
      } else {
        await saveUserMode("this-tab");
      }
    });
  }

  if (alwaysOnToggle) {
    alwaysOnToggle.addEventListener("change", async () => {
      if (alwaysOnToggle.disabled) {
        await refreshProtectionStatus();
        return;
      }
      if (!alwaysOnToggle.checked) {
        const current = await loadSettings();
        await saveUserMode(current.protectionMode === "off" ? "off" : "this-tab");
        return;
      }
      // Checked: access first, mode second. A denied prompt leaves this-tab
      // armed rather than a dead always-on selection.
      const granted = await requestSiteAccess();
      if (granted) {
        await saveUserMode("always-on");
      } else {
        await refreshProtectionStatus();
      }
    });
  }

  grantAccessBtn?.addEventListener("click", async () => {
    await requestSiteAccess();
    // The worker arms a pending always-on request on the permission-added
    // event; refresh here so the banner reflects the grant immediately.
    await refreshProtectionStatus();
  });

  // --- General & Appearance Controls ---
  const langSelect = document.getElementById("lang-select") as HTMLSelectElement | null;
  if (langSelect) {
    langSelect.value = settings.language;
    langSelect.addEventListener("change", async () => {
      const newLang = langSelect.value as LanguageCode;
      const current = await loadSettings();
      const updated = { ...current, language: newLang };
      await saveSettings(updated);
      applyUiLanguage(newLang);
      await renderCategories({ enabledCategories: updated.enabledCategories, language: newLang });
      speakAnnouncement(t(newLang, "speech_settings_saved"), updated);
    });
  }

  const fontSizeSelect = document.getElementById("font-size-select") as HTMLSelectElement | null;
  if (fontSizeSelect) {
    fontSizeSelect.value = settings.fontSize;
    fontSizeSelect.addEventListener("change", async () => {
      const newSize = fontSizeSelect.value as FontSizeScale;
      const current = await loadSettings();
      const updated = { ...current, fontSize: newSize };
      await saveSettings(updated);
      applyAccessibilitySettings(updated);
      speakAnnouncement(t(updated.language, "speech_settings_saved"), updated);
    });
  }

  const highContrastToggle = document.getElementById("high-contrast-toggle") as HTMLInputElement | null;
  if (highContrastToggle) {
    highContrastToggle.checked = settings.highContrast;
    highContrastToggle.setAttribute("aria-checked", settings.highContrast ? "true" : "false");
    highContrastToggle.addEventListener("change", async () => {
      highContrastToggle.setAttribute("aria-checked", highContrastToggle.checked ? "true" : "false");
      const current = await loadSettings();
      const updated = { ...current, highContrast: highContrastToggle.checked };
      await saveSettings(updated);
      applyAccessibilitySettings(updated);
      speakAnnouncement(t(updated.language, "speech_settings_saved"), updated);
    });
  }

  const dyslexiaToggle = document.getElementById("dyslexia-toggle") as HTMLInputElement | null;
  if (dyslexiaToggle) {
    dyslexiaToggle.checked = settings.dyslexiaMode;
    dyslexiaToggle.setAttribute("aria-checked", settings.dyslexiaMode ? "true" : "false");
    dyslexiaToggle.addEventListener("change", async () => {
      dyslexiaToggle.setAttribute("aria-checked", dyslexiaToggle.checked ? "true" : "false");
      const current = await loadSettings();
      const updated = { ...current, dyslexiaMode: dyslexiaToggle.checked };
      await saveSettings(updated);
      applyAccessibilitySettings(updated);
      speakAnnouncement(t(updated.language, "speech_settings_saved"), updated);
    });
  }

  const reducedMotionToggle = document.getElementById("reduced-motion-toggle") as HTMLInputElement | null;
  if (reducedMotionToggle) {
    reducedMotionToggle.checked = settings.reducedMotion;
    reducedMotionToggle.setAttribute("aria-checked", settings.reducedMotion ? "true" : "false");
    reducedMotionToggle.addEventListener("change", async () => {
      reducedMotionToggle.setAttribute("aria-checked", reducedMotionToggle.checked ? "true" : "false");
      const current = await loadSettings();
      const updated = { ...current, reducedMotion: reducedMotionToggle.checked };
      await saveSettings(updated);
      applyAccessibilitySettings(updated);
      speakAnnouncement(t(updated.language, "speech_settings_saved"), updated);
    });
  }

  // --- Accessibility & Assistive Tools Controls ---
  const speechToggle = document.getElementById("speech-toggle") as HTMLInputElement | null;
  if (speechToggle) {
    speechToggle.checked = settings.speechAnnouncements;
    speechToggle.setAttribute("aria-checked", settings.speechAnnouncements ? "true" : "false");
    speechToggle.addEventListener("change", async () => {
      speechToggle.setAttribute("aria-checked", speechToggle.checked ? "true" : "false");
      const current = await loadSettings();
      const updated = { ...current, speechAnnouncements: speechToggle.checked };
      await saveSettings(updated);
      speakAnnouncement(t(updated.language, "speech_settings_saved"), updated);
    });
  }

  const verboseAriaToggle = document.getElementById("verbose-aria-toggle") as HTMLInputElement | null;
  if (verboseAriaToggle) {
    verboseAriaToggle.checked = settings.ariaVerboseMode;
    verboseAriaToggle.setAttribute("aria-checked", settings.ariaVerboseMode ? "true" : "false");
    verboseAriaToggle.addEventListener("change", async () => {
      verboseAriaToggle.setAttribute("aria-checked", verboseAriaToggle.checked ? "true" : "false");
      const current = await loadSettings();
      const updated = { ...current, ariaVerboseMode: verboseAriaToggle.checked };
      await saveSettings(updated);
    });
  }

  // --- Mask Padding & Color Controls ---
  const maskPaddingSelect = document.getElementById("mask-padding-select") as HTMLSelectElement | null;
  if (maskPaddingSelect) {
    maskPaddingSelect.value = String(settings.maskPadding);
    maskPaddingSelect.addEventListener("change", async () => {
      const pad = parseInt(maskPaddingSelect.value, 10) ?? 4;
      const current = await loadSettings();
      await saveSettings({ ...current, maskPadding: pad });
    });
  }

  const maskColorSelect = document.getElementById("mask-color-select") as HTMLSelectElement | null;
  if (maskColorSelect) {
    maskColorSelect.value = settings.maskColor;
    maskColorSelect.addEventListener("change", async () => {
      const current = await loadSettings();
      await saveSettings({ ...current, maskColor: maskColorSelect.value });
    });
  }

  // --- Proactive Protection & Context Menus Controls ---
  const contextMenusToggle = document.getElementById("context-menus-toggle") as HTMLInputElement | null;
  if (contextMenusToggle) {
    contextMenusToggle.checked = settings.contextMenusEnabled;
    contextMenusToggle.setAttribute("aria-checked", settings.contextMenusEnabled ? "true" : "false");
    contextMenusToggle.addEventListener("change", async () => {
      contextMenusToggle.setAttribute("aria-checked", contextMenusToggle.checked ? "true" : "false");
      const current = await loadSettings();
      await saveSettings({ ...current, contextMenusEnabled: contextMenusToggle.checked });
    });
  }

  // --- Auto-Copy & Session Timeout Controls ---
  const autoCopyToggle = document.getElementById("auto-copy-toggle") as HTMLInputElement | null;
  if (autoCopyToggle) {
    autoCopyToggle.checked = settings.autoCopySanitized;
    autoCopyToggle.setAttribute("aria-checked", settings.autoCopySanitized ? "true" : "false");
    autoCopyToggle.addEventListener("change", async () => {
      autoCopyToggle.setAttribute("aria-checked", autoCopyToggle.checked ? "true" : "false");
      const current = await loadSettings();
      await saveSettings({ ...current, autoCopySanitized: autoCopyToggle.checked });
    });
  }

  const sessionTimeoutSelect = document.getElementById("session-timeout-select") as HTMLSelectElement | null;
  if (sessionTimeoutSelect) {
    sessionTimeoutSelect.value = settings.sessionTimeout;
    sessionTimeoutSelect.addEventListener("change", async () => {
      const current = await loadSettings();
      await saveSettings({ ...current, sessionTimeout: sessionTimeoutSelect.value as SessionTimeoutOption });
    });
  }

  // --- Document Studio Defaults ---
  const defaultDocStyleSelect = document.getElementById("default-doc-style-select") as HTMLSelectElement | null;
  if (defaultDocStyleSelect) {
    defaultDocStyleSelect.value = settings.defaultRedactionStyle;
    defaultDocStyleSelect.addEventListener("change", async () => {
      const current = await loadSettings();
      await saveSettings({ ...current, defaultRedactionStyle: defaultDocStyleSelect.value as RedactionStyle });
      if (docStyleSelect) docStyleSelect.value = defaultDocStyleSelect.value;
      if (docStampContainer) docStampContainer.hidden = docStyleSelect?.value !== "stamp";
      redrawAllOverlays();
    });
  }

  const defaultDocStampInput = document.getElementById("default-doc-stamp-input") as HTMLInputElement | null;
  const defaultDocStampPresets = document.getElementById("default-doc-stamp-presets") as HTMLSelectElement | null;

  const applyDefaultStampText = async (raw: string) => {
    const val = raw.trim() || "[REDACTED]";
    const current = await loadSettings();
    await saveSettings({ ...current, defaultStampText: val });
    if (docStampText) {
      docStampText.value = val;
      redrawAllOverlays();
    }
  };

  if (defaultDocStampInput) {
    defaultDocStampInput.value = settings.defaultStampText;
    defaultDocStampInput.addEventListener("change", () => void applyDefaultStampText(defaultDocStampInput.value));
  }
  if (defaultDocStampPresets && defaultDocStampInput) {
    defaultDocStampPresets.addEventListener("change", () => {
      defaultDocStampInput.value = defaultDocStampPresets.value;
      void applyDefaultStampText(defaultDocStampPresets.value);
    });
  }

  // --- Reset Settings & Clear Audit Controls ---
  const resetSettingsBtn = document.getElementById("reset-settings-btn") as HTMLButtonElement | null;
  const resetConfirmDialog = document.getElementById("reset-confirm-dialog") as HTMLDialogElement | null;
  const resetCancel = document.getElementById("reset-cancel") as HTMLButtonElement | null;
  const resetConfirm = document.getElementById("reset-confirm") as HTMLButtonElement | null;

  resetSettingsBtn?.addEventListener("click", () => {
    resetConfirmDialog?.showModal();
  });
  resetCancel?.addEventListener("click", () => {
    resetConfirmDialog?.close();
  });
  resetConfirm?.addEventListener("click", async () => {
    resetConfirmDialog?.close();
    const defaults = await resetSettings();
    applyUiLanguage(defaults.language);
    applyAccessibilitySettings(defaults);
    await refreshProtectionStatus();

    if (langSelect) langSelect.value = defaults.language;
    if (fontSizeSelect) fontSizeSelect.value = defaults.fontSize;
    if (highContrastToggle) {
      highContrastToggle.checked = defaults.highContrast;
      highContrastToggle.setAttribute("aria-checked", "false");
    }
    if (dyslexiaToggle) {
      dyslexiaToggle.checked = defaults.dyslexiaMode;
      dyslexiaToggle.setAttribute("aria-checked", "false");
    }
    if (reducedMotionToggle) {
      reducedMotionToggle.checked = defaults.reducedMotion;
      reducedMotionToggle.setAttribute("aria-checked", "false");
    }
    if (speechToggle) {
      speechToggle.checked = defaults.speechAnnouncements;
      speechToggle.setAttribute("aria-checked", "false");
    }
    if (verboseAriaToggle) {
      verboseAriaToggle.checked = defaults.ariaVerboseMode;
      verboseAriaToggle.setAttribute("aria-checked", "false");
    }
    if (placeholderToggle) {
      placeholderToggle.checked = defaults.maskPlaceholders;
      placeholderToggle.setAttribute("aria-checked", "false");
    }
    // Mode toggles, banner, categories, and lock notice are synced by the
    // refreshProtectionStatus() call above.
    if (contextMenusToggle) {
      contextMenusToggle.checked = defaults.contextMenusEnabled;
      contextMenusToggle.setAttribute("aria-checked", "true");
    }
    if (maskPaddingSelect) maskPaddingSelect.value = String(defaults.maskPadding);
    if (maskColorSelect) maskColorSelect.value = defaults.maskColor;
    if (autoCopyToggle) {
      autoCopyToggle.checked = defaults.autoCopySanitized;
      autoCopyToggle.setAttribute("aria-checked", "false");
    }
    if (sessionTimeoutSelect) sessionTimeoutSelect.value = defaults.sessionTimeout;
    if (defaultDocStyleSelect) defaultDocStyleSelect.value = defaults.defaultRedactionStyle;
    if (defaultDocStampInput) defaultDocStampInput.value = defaults.defaultStampText;
    if (ocrLangSelect) ocrLangSelect.value = defaults.ocrLanguage;
    if (docOcrLangSelect) docOcrLangSelect.value = defaults.ocrLanguage;

    speakAnnouncement(t(defaults.language, "speech_settings_reset"), defaults);
  });

  const clearAuditBtn = document.getElementById("clear-audit-btn") as HTMLButtonElement | null;
  const clearAuditDialog = document.getElementById("clear-audit-dialog") as HTMLDialogElement | null;
  const clearAuditCancel = document.getElementById("clear-audit-cancel") as HTMLButtonElement | null;
  const clearAuditConfirm = document.getElementById("clear-audit-confirm") as HTMLButtonElement | null;

  clearAuditBtn?.addEventListener("click", () => {
    clearAuditDialog?.showModal();
  });
  clearAuditCancel?.addEventListener("click", () => {
    clearAuditDialog?.close();
  });
  clearAuditConfirm?.addEventListener("click", async () => {
    clearAuditDialog?.close();
    await chrome.storage.local.remove(["audit_log", "audit_key"]);
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "audit_cleared"), current);
  });

  document.getElementById("export-audit-btn")?.addEventListener("click", () => {
    void sendMessage({ type: "POPUP_EXPORT_AUDIT", requestId: requestId() });
  });

  // ---------- Notifications & Account Settings ----------
  const notificationsToggle = document.getElementById("notifications-toggle") as HTMLInputElement | null;
  const notificationsStatus = document.getElementById("notifications-status") as HTMLParagraphElement | null;
  if (notificationsToggle) {
    notificationsToggle.checked = settings.notificationsEnabled;
    notificationsToggle.setAttribute("aria-checked", notificationsToggle.checked ? "true" : "false");
    notificationsToggle.addEventListener("change", () => {
      notificationsToggle.setAttribute("aria-checked", notificationsToggle.checked ? "true" : "false");
      void chrome.runtime.sendMessage({
        type: "POPUP_SET_NOTIFICATIONS",
        requestId: requestId(),
        enabled: notificationsToggle.checked,
      });
    });
  }

  const originInput = document.getElementById("gateway-origin-input") as HTMLInputElement | null;
  const keyInput = document.getElementById("gateway-key-input") as HTMLInputElement | null;
  const saveBtn = document.getElementById("account-save-btn") as HTMLButtonElement | null;
  const purchaseBtn = document.getElementById("account-purchase-btn") as HTMLButtonElement | null;
  const accountStatus = document.getElementById("account-status") as HTMLParagraphElement | null;
  const oauthConnectBtn = document.getElementById("oauth-connect-btn") as HTMLButtonElement | null;
  const oauthStatus = document.getElementById("oauth-status") as HTMLParagraphElement | null;

  oauthConnectBtn?.addEventListener("click", () => {
    if (oauthStatus) oauthStatus.textContent = "Opening GovernWorld sign-in…";
    void chrome.runtime.sendMessage({
      type: "POPUP_OAUTH_CONNECT",
      requestId: requestId(),
    });
  });

  purchaseBtn?.addEventListener("click", () => {
    if (accountStatus) {
      void (async () => {
        const current = await loadSettings();
        accountStatus.textContent = t(current.language, "opening_stripe");
      })();
    }
    void chrome.runtime.sendMessage({
      type: "POPUP_ACCOUNT_PURCHASE",
      requestId: requestId(),
      planId: "redaction-extension-addon",
    });
  });

  saveBtn?.addEventListener("click", () => {
    if (!originInput || !keyInput || !accountStatus) return;
    const gatewayOrigin = originInput.value.trim().replace(/\/+$/, "");
    const apiKey = keyInput.value.trim();
    if (!/^https:\/\/[^/]+$/.test(gatewayOrigin)) {
      accountStatus.textContent = "Gateway origin must be a bare https URL (no path).";
      return;
    }
    if (!/^gw_(live|test)_[A-Za-z0-9]{8,}$/.test(apiKey)) {
      accountStatus.textContent = "API key must start with gw_live_ or gw_test_.";
      return;
    }
    accountStatus.textContent = "Saving account…";
    void chrome.runtime.sendMessage({
      type: "POPUP_ACCOUNT_SAVE",
      requestId: requestId(),
      gatewayOrigin,
      apiKey,
    });
  });

  // ---------- Redaction Wizard & Custom Rules Controller ----------
  const openWizardBtn = document.getElementById("open-wizard-btn") as HTMLButtonElement | null;
  const linkCommunityBtn = document.getElementById("link-community-btn") as HTMLButtonElement | null;
  const fetchCommunityRulesBtn = document.getElementById("fetch-community-rules-btn") as HTMLButtonElement | null;
  const customPatternsList = document.getElementById("custom-patterns-list") as HTMLUListElement | null;
  const noCustomPatterns = document.getElementById("no-custom-patterns") as HTMLParagraphElement | null;
  const communityRulesList = document.getElementById("community-rules-list") as HTMLUListElement | null;
  const communityAccountStatus = document.getElementById("community-account-status") as HTMLParagraphElement | null;

  if (linkCommunityBtn) {
    linkCommunityBtn.disabled = true;
    linkCommunityBtn.title = "Community account linking is unavailable until server authorization is configured.";
  }
  if (fetchCommunityRulesBtn) {
    fetchCommunityRulesBtn.disabled = true;
    fetchCommunityRulesBtn.title = "Community rule retrieval is unavailable until the server integration is configured.";
  }

  const wizardDialog = document.getElementById("wizard-dialog") as HTMLDialogElement | null;
  const wizardStep1 = document.getElementById("wizard-step-1") as HTMLDivElement | null;
  const wizardStep2 = document.getElementById("wizard-step-2") as HTMLDivElement | null;
  const wizardStep3 = document.getElementById("wizard-step-3") as HTMLDivElement | null;
  const wizardStep4 = document.getElementById("wizard-step-4") as HTMLDivElement | null;

  const wizardPosInput = document.getElementById("wizard-pos-input") as HTMLTextAreaElement | null;
  const wizardNegInput = document.getElementById("wizard-neg-input") as HTMLTextAreaElement | null;
  const wizardCancel1 = document.getElementById("wizard-cancel-1") as HTMLButtonElement | null;
  const wizardAnalyzeBtn = document.getElementById("wizard-analyze-btn") as HTMLButtonElement | null;

  const wizardProposalsContainer = document.getElementById("wizard-proposals-container") as HTMLDivElement | null;
  const wizardBack2 = document.getElementById("wizard-back-2") as HTMLButtonElement | null;
  const wizardNext2 = document.getElementById("wizard-next-2") as HTMLButtonElement | null;

  const wizardRegexInput = document.getElementById("wizard-regex-input") as HTMLInputElement | null;
  const wizardTestSample = document.getElementById("wizard-test-sample") as HTMLTextAreaElement | null;
  const wizardTestResultsBox = document.getElementById("wizard-test-results-box") as HTMLDivElement | null;
  const wizardBack3 = document.getElementById("wizard-back-3") as HTMLButtonElement | null;
  const wizardNext3 = document.getElementById("wizard-next-3") as HTMLButtonElement | null;

  const wizardRuleName = document.getElementById("wizard-rule-name") as HTMLInputElement | null;
  const wizardRuleCategory = document.getElementById("wizard-rule-category") as HTMLSelectElement | null;
  const wizardRuleConfidence = document.getElementById("wizard-rule-confidence") as HTMLInputElement | null;
  const wizardBack4 = document.getElementById("wizard-back-4") as HTMLButtonElement | null;
  const wizardSaveBtn = document.getElementById("wizard-save-btn") as HTMLButtonElement | null;

  const contribConsentDialog = document.getElementById("contrib-consent-dialog") as HTMLDialogElement | null;
  const contribConsentCheckbox = document.getElementById("contrib-consent-checkbox") as HTMLInputElement | null;
  const contribCancelBtn = document.getElementById("contrib-cancel-btn") as HTMLButtonElement | null;
  const contribConfirmBtn = document.getElementById("contrib-confirm-btn") as HTMLButtonElement | null;

  let currentProposals: WizardAnalysis[] = [];
  let selectedProposalIndex = 0;
  let contributeTargetPatternId: string | null = null;
  let isCommunityLinked = false;

  function showWizardStep(step: 1 | 2 | 3 | 4) {
    if (!wizardStep1 || !wizardStep2 || !wizardStep3 || !wizardStep4) return;
    wizardStep1.hidden = step !== 1;
    wizardStep2.hidden = step !== 2;
    wizardStep3.hidden = step !== 3;
    wizardStep4.hidden = step !== 4;
  }

  openWizardBtn?.addEventListener("click", () => {
    if (!wizardPosInput || !wizardNegInput || !wizardRegexInput || !wizardTestSample || !wizardRuleName || !wizardRuleConfidence || !wizardDialog) return;
    wizardPosInput.value = "";
    wizardNegInput.value = "";
    wizardRegexInput.value = "";
    wizardTestSample.value = "";
    wizardRuleName.value = "";
    wizardRuleConfidence.value = "0.85";
    currentProposals = [];
    selectedProposalIndex = 0;
    showWizardStep(1);
    wizardDialog.showModal();
  });

  wizardCancel1?.addEventListener("click", () => wizardDialog?.close());

  wizardAnalyzeBtn?.addEventListener("click", () => {
    if (!wizardPosInput || !wizardNegInput) return;
    const pos = wizardPosInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
    const neg = wizardNegInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (pos.length === 0) {
      void (async () => {
        const current = await loadSettings();
        alert(t(current.language, "wizard_need_positive"));
      })();
      return;
    }
    void chrome.runtime.sendMessage({
      type: "POPUP_WIZARD_ANALYZE",
      requestId: requestId(),
      positiveExamples: pos,
      negativeExamples: neg,
    });
  });

  wizardBack2?.addEventListener("click", () => showWizardStep(1));
  wizardNext2?.addEventListener("click", () => {
    const selected = currentProposals[selectedProposalIndex];
    if (selected && wizardRegexInput) {
      wizardRegexInput.value = selected.proposedPattern;
    }
    const pos = wizardPosInput ? wizardPosInput.value.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    if (pos.length > 0 && wizardTestSample) {
      wizardTestSample.value = pos.join("\n");
    }
    triggerWizardTest();
    showWizardStep(3);
  });

  function triggerWizardTest() {
    if (!wizardRegexInput || !wizardTestSample) return;
    const regex = wizardRegexInput.value.trim();
    const text = wizardTestSample.value;
    if (regex) {
      void chrome.runtime.sendMessage({
        type: "POPUP_WIZARD_TEST",
        requestId: requestId(),
        regex,
        sampleText: text,
      });
    }
  }

  wizardRegexInput?.addEventListener("input", triggerWizardTest);
  wizardTestSample?.addEventListener("input", triggerWizardTest);

  wizardBack3?.addEventListener("click", () => showWizardStep(2));
  wizardNext3?.addEventListener("click", () => showWizardStep(4));

  wizardBack4?.addEventListener("click", () => showWizardStep(3));
  wizardSaveBtn?.addEventListener("click", () => {
    if (!wizardRuleName || !wizardRegexInput || !wizardRuleCategory || !wizardRuleConfidence || !wizardDialog) return;
    const name = wizardRuleName.value.trim() || "Custom Pattern";
    const patternStr = wizardRegexInput.value.trim();
    if (!patternStr) {
      alert("Please enter a valid regex pattern.");
      return;
    }
    const pattern: CustomPattern = {
      id: crypto.randomUUID(),
      name,
      category: wizardRuleCategory.value as any,
      pattern: patternStr,
      flags: "gi",
      captureGroup: 0,
      confidence: parseFloat(wizardRuleConfidence.value) || 0.85,
      createdAt: new Date().toISOString(),
      source: "local",
      contributionStatus: "local_only",
    };

    void chrome.runtime.sendMessage({
      type: "POPUP_CUSTOM_PATTERN_SAVE",
      requestId: requestId(),
      pattern,
    });
    wizardDialog.close();
  });

  contribConsentCheckbox?.addEventListener("change", () => {
    if (contribConfirmBtn) contribConfirmBtn.disabled = !contribConsentCheckbox.checked;
  });

  contribCancelBtn?.addEventListener("click", () => contribConsentDialog?.close());
  contribConfirmBtn?.addEventListener("click", () => {
    if (contributeTargetPatternId) {
      void chrome.runtime.sendMessage({
        type: "POPUP_COMMUNITY_CONTRIBUTE",
        requestId: requestId(),
        patternId: contributeTargetPatternId,
      });
    }
    contribConsentDialog?.close();
  });

  linkCommunityBtn?.addEventListener("click", () => {
    if (isCommunityLinked) {
      void chrome.runtime.sendMessage({ type: "POPUP_COMMUNITY_ACCOUNT_UNLINK", requestId: requestId() });
    } else {
      void chrome.runtime.sendMessage({ type: "POPUP_COMMUNITY_ACCOUNT_LINK_FREE", requestId: requestId() });
    }
  });

  fetchCommunityRulesBtn?.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "POPUP_COMMUNITY_FETCH_COMMUNITY_RULES", requestId: requestId() });
  });

  function renderCustomPatterns(patterns: CustomPattern[]) {
    if (!customPatternsList || !noCustomPatterns) return;
    customPatternsList.replaceChildren();
    if (!patterns || patterns.length === 0) {
      noCustomPatterns.hidden = false;
      return;
    }
    noCustomPatterns.hidden = true;
    for (const pat of patterns) {
      const item = document.createElement("li");
      item.className = "finding";
      item.style.flexDirection = "column";
      item.style.alignItems = "stretch";

      const topRow = document.createElement("div");
      topRow.style.display = "flex";
      topRow.style.justifyContent = "space-between";
      topRow.style.alignItems = "center";

      const nameSpan = document.createElement("strong");
      nameSpan.textContent = pat.name;
      nameSpan.style.fontSize = "12px";

      const actionsDiv = document.createElement("div");
      actionsDiv.style.display = "flex";
      actionsDiv.style.gap = "6px";
      actionsDiv.style.alignItems = "center";

      const delBtn = document.createElement("button");
      delBtn.className = "btn btn--ghost btn--sm";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => {
        void chrome.runtime.sendMessage({
          type: "POPUP_CUSTOM_PATTERN_DELETE",
          requestId: requestId(),
          patternId: pat.id,
        });
      });

      if (pat.contributionStatus === "submitted" || pat.contributionStatus === "accepted") {
        const badge = document.createElement("span");
        badge.className = "finding__severity";
        badge.textContent = "Contributed";
        badge.dataset.level = "high";
        actionsDiv.append(badge, delBtn);
      } else {
        const contribBtn = document.createElement("button");
        contribBtn.className = "btn btn--ghost btn--sm";
        contribBtn.textContent = "Unavailable";
        contribBtn.disabled = true;
        contribBtn.title = "Community contributions are unavailable until server authorization and consent recording are configured.";
        actionsDiv.append(contribBtn, delBtn);
      }

      topRow.append(nameSpan, actionsDiv);

      const codeBox = document.createElement("code");
      codeBox.textContent = `/${pat.pattern}/${pat.flags} [${pat.category}]`;
      codeBox.style.fontSize = "11px";
      codeBox.style.color = "var(--text-muted)";
      codeBox.style.marginTop = "4px";

      item.append(topRow, codeBox);
      customPatternsList.appendChild(item);
    }
  }

  function renderCommunityAccount(_account: CommunityAccount | null) {
    isCommunityLinked = false;
    if (linkCommunityBtn) linkCommunityBtn.textContent = "Community Account Unavailable";
    if (communityAccountStatus) communityAccountStatus.textContent = "Community features are unavailable until server authorization is configured.";
  }

  function renderCommunityRules(rules: CommunityRule[]) {
    if (!communityRulesList) return;
    communityRulesList.replaceChildren();
    if (!rules || rules.length === 0) {
      const empty = document.createElement("p");
      empty.className = "footnote";
      empty.textContent = "No community rules fetched yet.";
      communityRulesList.appendChild(empty);
      return;
    }
    for (const rule of rules) {
      const item = document.createElement("li");
      item.className = "finding";
      item.style.flexDirection = "column";

      const title = document.createElement("strong");
      title.textContent = `${rule.name} (by ${rule.createdByHandle})`;
      title.style.fontSize = "12px";

      const code = document.createElement("code");
      code.textContent = `/${rule.pattern}/${rule.flags} [${rule.category}]`;
      code.style.fontSize = "11px";
      code.style.color = "var(--text-muted)";

      item.append(title, code);
      communityRulesList.appendChild(item);
    }
  }

  /** Show the one-time "verify your work" accuracy notice after a scan completes. */
  async function maybeShowVerifyNotice(): Promise<void> {
    const currentSettings = await loadSettings();
    if (currentSettings.verificationNoticeAcknowledged) return;
    const dialog = document.getElementById("verify-dialog") as HTMLDialogElement | null;
    if (!dialog) return;
    const dismiss = document.getElementById("verify-dismiss") as HTMLButtonElement | null;
    const understood = document.getElementById("verify-understood") as HTMLButtonElement | null;
    const acknowledge = async (): Promise<void> => {
      dialog.close();
      const current = await loadSettings();
      await saveSettings({ ...current, verificationNoticeAcknowledged: true });
    };
    dismiss?.addEventListener("click", () => void acknowledge());
    understood?.addEventListener("click", () => void acknowledge());
    dialog.showModal();
  }

  chrome.runtime.onMessage.addListener(async (raw: unknown) => {
    const validation = validateMessage(raw);
    if (!validation.ok) return;
    const message = validation.message;
    if (message.type === "POPUP_STATE") {
      const priorState = lastState;
      lastState = message.state;
      renderState(lastState);
      if (priorState?.scanning && !lastState.scanning && lastState.scanned) {
        void (async () => {
          const current = await loadSettings();
          if (lastState && lastState.findings.length > 0) {
            speakAnnouncement(t(current.language, "speech_scan_complete", { count: lastState.findings.length }), current);
          } else {
            speakAnnouncement(t(current.language, "speech_scan_none"), current);
          }
        })();
      }
      if (lastState.scanned && lastState.findings.length > 0) {
        void maybeShowVerifyNotice();
      }
      return;
    }
    if (message.type === "POPUP_COPY_RESULT") {
      const text = message.text;
      void (async () => {
        await copyToClipboard(text);
        const status = document.getElementById("status") as HTMLParagraphElement | null;
        if (status) {
          status.textContent = "Copied redacted text to clipboard.";
          status.classList.remove("status--error");
        }
      })();
      return;
    }
    if (message.type === "POPUP_AUDIT_EXPORT") {
      const download = (content: string, filename: string, mime: string): void => {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      };
      download(message.jsonl, `governworld-audit-${message.exportedAt.split("T")[0]}.jsonl`, "application/jsonl");
      download(
        JSON.stringify({ signature: message.signatureBase64, publicKeyJwk: message.publicKeyJwk, exportedAt: message.exportedAt }, null, 2),
        `governworld-audit-${message.exportedAt.split("T")[0]}.sig.json`,
        "application/json"
      );
      return;
    }
    if (message.type === "POPUP_DOC_CAPTURE_READY") {
      // The worker staged the image lifted off the page. Preview it through the
      // ordinary document path, so OCR, review, redaction, download and print
      // are exactly the ones an uploaded file gets - there is no second
      // redaction surface to keep in step with the first.
      hideDocProgress();
      beginDocSession({
        fileKey: message.fileKey,
        name: message.name,
        mimeType: message.mimeType,
        kind: message.kind,
      });
      setDocStatus(
        message.degraded ? t(currentLang, "image_capture_screen") : t(currentLang, "image_capture_full"),
        false
      );
      showDocProgress();
      void sendDocMessage({
        type: "POPUP_DOC_PREVIEW",
        requestId: requestId(),
        fileKey: message.fileKey,
        name: message.name,
        mimeType: message.mimeType,
        kind: message.kind,
      });
      return;
    }
    if (message.type === "POPUP_DOC_STATE") {
      hideDocProgress();
      // Match on fileKey so the first reply can land on the placeholder session
      // created by beginDocSession(), which has no docId yet. Fall back to docId
      // for a session the worker has already identified.
      //
      // A null `lastDoc` is not a mismatch: it means the popup was just opened
      // and the worker is naming the document that is already loaded. Dropping
      // that message is what left the studio empty after a reload, so adopt it.
      if (!lastDoc) {
        lastDoc = {
          docId: message.docId,
          fileKey: message.fileKey,
          name: message.name,
          mimeType: message.mimeType,
          kind: message.kind,
          pages: [],
        };
      } else if (lastDoc.docId ? message.docId !== lastDoc.docId : message.fileKey !== lastDoc.fileKey) {
        return;
      }
      const doc = lastDoc;
      doc.docId = message.docId;
      doc.name = message.name;
      doc.fileKey = message.fileKey;
      doc.mimeType = message.mimeType;
      doc.kind = message.kind;
      doc.pages = message.pages;
      renderDoc(doc);
      const found = message.pages.reduce((n, p) => n + p.findings.length, 0);
      // The preview is finished, so the progress row must stay down. Calling
      // renderDocStage() unconditionally re-showed it with "Processing
      // document..." next to a Cancel button, leaving a spinner running forever
      // on an already-processed document. The studio itself now carries the
      // result (page count, per-page findings, and the findings badge).
      hideDocProgress();
      if (found === 0) {
        setDocStatus("No sensitive values were found in this document.", true);
      } else {
        setDocStatus("", false);
      }
      return;
    }
    if (message.type === "POPUP_DOC_DONE") {
      // The redaction is finished, so the progress row must come down. The
      // worker streams POPUP_DOC_STATUS verification updates, and each one
      // re-showed that row, leaving a spinner and a Cancel button next to a
      // document that had already been written. The verification result is the
      // most trust-relevant line for a redaction tool, so it is carried into
      // the status instead of being dropped with the row.
      const verificationNote = (() => {
        const progressText = (document.getElementById("doc-progress-text")?.textContent || "").trim();
        hideDocProgress();
        return /regions?/.test(progressText) ? progressText : "";
      })();
      const finishWith = (text: string, isError: boolean): void => {
        setDocStatus(verificationNote ? `${text} ${verificationNote}.` : text, isError);
      };
      void (async () => {
        const current = await loadSettings();
        speakAnnouncement(t(current.language, "speech_doc_redacted"), current);
      })();
      const reportDelivery = (delivered: boolean) => {
        void sendMessage({
          type: "POPUP_DOC_DELIVERY_REPORT",
          requestId: message.requestId,
          delivered,
        });
      };
      if ((message as any).outputBytesBase64 && (message as any).outputMimeType) {
        try {
          const b64 = (message as any).outputBytesBase64 as string;
          const mime = (message as any).outputMimeType as string;
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: mime });
          const url = URL.createObjectURL(blob);

          const deliverViaDownloads = async (): Promise<boolean> => {
            try {
              await chrome.downloads.download({ url, filename: message.outputName, saveAs: true });
              return true;
            } catch {
              return false;
            }
          };
          const deliverViaAnchor = async (): Promise<boolean> => {
            try {
              const a = document.createElement("a");
              a.href = url;
              a.download = message.outputName;
              a.click();
              return true;
            } catch {
              return false;
            }
          };

          void (async () => {
            const hasDownloadsApi = typeof chrome !== "undefined" && Boolean(chrome.downloads?.download);
            const delivered = hasDownloadsApi ? await deliverViaDownloads() : false;
            const finalOutcome = delivered ? true : await deliverViaAnchor();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            reportDelivery(finalOutcome);
          })();

          const current = await loadSettings();
          finishWith(t(current.language, "doc_downloaded", { name: message.outputName }), false);
        } catch {
          reportDelivery(false);
          const current = await loadSettings();
          finishWith(t(current.language, "doc_save_failed", { name: message.outputName }), true);
        }
      } else {
        finishWith(`Saved ${message.outputName}. The original file was not changed.`, false);
      }

      // Offer the print view only when the worker actually staged verified
      // pages. Absent printFileKey means staging failed; the download above is
      // still correct, so the redaction is not treated as a failure.
      if (printBar) {
        if (message.printFileKey) {
          lastPrintFileKey = message.printFileKey;
          printBar.hidden = false;
        } else {
          printBar.hidden = true;
          lastPrintFileKey = null;
        }
      }
      clearDocUi();
      return;
    }
    if (message.type === "POPUP_DOC_STATUS") {
      renderDocStage(message);
      return;
    }
    if (message.type === "POPUP_DOC_ERROR") {
      // The run is over, so the spinner has to stop; leaving it up would show
      // "Processing document..." next to an error.
      hideDocProgress();
      setDocStatus(message.userMessage, true);
      return;
    }
    if (message.type === "POPUP_NOTIFICATIONS_STATE") {
      if (notificationsToggle) {
        notificationsToggle.checked = message.granted;
        notificationsToggle.setAttribute("aria-checked", message.granted ? "true" : "false");
      }
      if (notificationsStatus) {
        const current = await loadSettings();
        notificationsStatus.textContent = message.granted
          ? t(current.language, "notifications_enabled")
          : t(current.language, "notifications_denied");
      }
      return;
    }
    if (message.type === "POPUP_ACCOUNT_STATE") {
      if (accountStatus) {
        if (message.error) {
          accountStatus.textContent = message.error.userMessage;
          return;
        }
        if (message.linked) {
          if (originInput) originInput.value = message.gatewayOrigin ?? "";
          if (keyInput) keyInput.value = "";
          if (message.credentialAvailable === false) {
            if (purchaseBtn) purchaseBtn.hidden = true;
            accountStatus.textContent =
              "Linked — re-enter your key to continue purchases in this browser session.";
            return;
          }
          if (purchaseBtn) purchaseBtn.hidden = false;
          accountStatus.textContent = message.accountLabel
            ? `Linked: ${message.accountLabel}`
            : "Linked to your GovernWorld workspace.";
        } else {
          if (purchaseBtn) purchaseBtn.hidden = true;
          accountStatus.textContent = "No account linked.";
        }
      }
      return;
    }
    if (message.type === "POPUP_ACCOUNT_PURCHASE_URL") {
      if (accountStatus) {
        const current = await loadSettings();
        accountStatus.textContent = t(current.language, "stripe_checkout_opened");
      }
      return;
    }
    if (message.type === "POPUP_OAUTH_STATUS") {
      if (oauthStatus) {
        if (message.connected) {
          oauthStatus.textContent = `Connected to ${message.tenantName ?? "GovernWorld"}`;
          if (oauthConnectBtn) {
            oauthConnectBtn.textContent = "Disconnect";
            oauthConnectBtn.onclick = () => {
              void chrome.runtime.sendMessage({
                type: "POPUP_API_DISCONNECT",
                requestId: requestId(),
              });
            };
          }
        } else if (message.message) {
          oauthStatus.textContent = message.message;
        }
      }
      return;
    }
    if (message.type === "POPUP_CUSTOM_PATTERNS_STATE") {
      renderCustomPatterns(message.patterns);
      return;
    }
    if (message.type === "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE") {
      renderCommunityAccount(message.account);
      return;
    }
    if (message.type === "POPUP_COMMUNITY_COMMUNITY_RULES_STATE") {
      renderCommunityRules(message.rules);
      return;
    }
    if (message.type === "POPUP_WIZARD_ANALYSIS_RESULT") {
      currentProposals = message.proposals;
      selectedProposalIndex = 0;
      if (wizardProposalsContainer) {
        wizardProposalsContainer.replaceChildren();
        if (currentProposals.length === 0) {
          const noProp = document.createElement("p");
          noProp.className = "footnote";
          noProp.textContent = "No regex proposals found for these examples.";
          wizardProposalsContainer.appendChild(noProp);
        } else {
          currentProposals.forEach((analysis, i) => {
            const card = document.createElement("div");
            card.style.padding = "8px";
            card.style.background = "var(--bg-inset)";
            card.style.border = "1px solid var(--border)";
            card.style.borderRadius = "var(--radius-sm)";
            card.style.cursor = "pointer";

            const title = document.createElement("strong");
            title.textContent = "Proposed pattern";
            title.style.fontSize = "12px";

            const code = document.createElement("code");
            code.textContent = `/${analysis.proposedPattern}/${analysis.proposedFlags}`;
            code.style.display = "block";
            code.style.fontSize = "11px";
            code.style.marginTop = "2px";

            const meta = document.createElement("p");
            meta.className = "footnote";
            meta.textContent = `Matches ${Math.round(analysis.qualityScore * 100)}% of positive examples`;

            card.append(title, code, meta);
            card.addEventListener("click", () => {
              selectedProposalIndex = i;
              Array.from(wizardProposalsContainer.children).forEach((c) => {
                (c as HTMLElement).style.borderColor = "var(--border)";
              });
              card.style.borderColor = "var(--accent)";
            });
            if (i === 0) card.style.borderColor = "var(--accent)";
            wizardProposalsContainer.appendChild(card);
          });
        }
      }
      showWizardStep(2);
      return;
    }
    if (message.type === "POPUP_WIZARD_TEST_RESULT") {
      if (wizardTestResultsBox) {
        const matchesCount = message.testResult.reduce(
          (sum, r) => sum + (r.matched ? r.matchCount : 0),
          0
        );
        wizardTestResultsBox.textContent = `Pattern matched ${matchesCount} instance(s) in sample text.`;
        wizardTestResultsBox.style.color = matchesCount > 0 ? "var(--ok)" : "var(--warning)";
      }
      return;
    }
  });

  void sendMessage({ type: "POPUP_GET_STATE", requestId: requestId() });

  // Readiness marker for the automated harnesses, set only once every listener
  // above is bound.
  //
  // `initPopup` awaits settings and storage before it attaches anything, which
  // takes seconds on a cold profile. The harnesses used a fixed 2-2.5s sleep and
  // then drove the UI, so they dispatched events on inputs with nothing bound to
  // them and reported the resulting silence as a product failure. They now poll
  // for this instead of guessing.
  //
  // Placed at the very end deliberately: any earlier and it would claim the popup
  // is interactive while it is not.
  document.documentElement.dataset.gwReady = "1";
}
