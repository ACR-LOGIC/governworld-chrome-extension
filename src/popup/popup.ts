// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { validateMessage } from "../shared/messages.js";
import { ALL_CATEGORIES, loadSettings, saveSettings, PRESET_CATEGORIES, PRESET_LABELS, type PresetId, type Settings } from "../shared/settings.js";
import { recordAudit } from "../shared/audit.js";
import type { DocKind, Finding, FindingCategory, PopupState, PopupMessage, ScanMode, DocPageMeta, PopupFromWorker, Rect, RedactionStyle } from "../shared/types.js";
import type { CustomPattern, CommunityAccount, CommunityRule } from "../shared/customPatterns.js";
import type { WizardAnalysis } from "../shared/wizardAnalyzer.js";

const CATEGORY_LABELS: Record<string, string> = {
  email: "Email address",
  phone: "US phone number",
  ssn: "Social Security number",
  dob: "Date of birth",
  medical_record_number: "Medical record number",
  member_id: "Member / patient ID",
  npi: "Provider NPI",
  dea: "DEA registration",
  mbi: "Medicare Beneficiary ID",
  address: "US address",
  payment_card: "Payment card",
  secrets: "API keys & secrets",
  possible_name: "Possible name",
  canadian_sin: "Canadian SIN",
  uk_nhs: "UK NHS Number",
  aadhaar: "Indian Aadhaar",
  pan_india: "Indian PAN",
  australian_tfn: "Australian TFN",
  cpf: "Brazilian CPF",
  custom: "Custom pattern",
};

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
const DB_NAME = "governworld-redaction";
const DB_VERSION = 1;
const STORE = "docfiles";
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

async function storeFile(fileKey: string, bytes: ArrayBuffer): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(bytes, fileKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not store the file"));
  });
}

async function deleteFile(fileKey: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(fileKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not delete the file"));
  });
}

async function renderCategories(settings: { enabledCategories: FindingCategory[] }): Promise<void> {
  const list = document.getElementById("category-list") as HTMLFieldSetElement | null;
  if (!list) return;
  list.replaceChildren();
  for (const category of ALL_CATEGORIES) {
    const label = el("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = category;
    check.checked = settings.enabledCategories.includes(category);
    const span = el("span", undefined, CATEGORY_LABELS[category]);
    label.append(check, span);
    check.addEventListener("change", async () => {
      const current = await loadSettings();
      const priorPreset = presetForCategories(current.enabledCategories);
      const set = new Set(current.enabledCategories);
      if (check.checked) set.add(category);
      else set.delete(category);
      const next = ALL_CATEGORIES.filter((c) => set.has(c));
      await saveSettings({ ...current, enabledCategories: next });
      await renderCategories({ enabledCategories: next });
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
function presetForCategories(enabledCategories: FindingCategory[]): PresetId {
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

async function applyPreset(presetId: PresetId): Promise<void> {
  if (presetId === "custom") return;
  const categories = PRESET_CATEGORIES[presetId];
  if (!categories) return;
  const current = await loadSettings();
  const previousPreset = presetForCategories(current.enabledCategories);
  await saveSettings({ ...current, enabledCategories: categories });
  await renderCategories({ enabledCategories: categories });
  if (previousPreset !== presetId) {
    await recordAudit({
      ts: new Date().toISOString(),
      action: "preset_applied",
      presetId,
      enabledCategories: categories,
      outcome: "ok",
    });
  }
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
      check = document.createElement("input");
      check.type = "checkbox";
      check.className = "finding__check";
      check.value = finding.id;
      check.checked = finding.selected;
      check.setAttribute("aria-label", `Select ${CATEGORY_LABELS[finding.category]} finding`);
      check.addEventListener("change", () => {
        const checked = [...list.querySelectorAll("input[type='checkbox']:checked")].map(
          (c) => (c as HTMLInputElement).value
        );
        void sendMessage({ type: "POPUP_APPLY_MASKS", requestId: requestId(), findingIds: checked });
      });
    }

    const main = el("div", "finding__main");
    const head = el("div", "finding__head");
    const category = el("div", "finding__category", CATEGORY_LABELS[finding.category]);
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
  applyBtn.textContent = `Apply selected masks (${selected})`;
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
    badge.textContent = state.mode === "cloud" ? "Cloud processing" : "Local processing";
    badge.classList.toggle("badge--cloud", state.mode === "cloud");
  }
  if (scanBtn) {
    scanBtn.disabled = state.scanning;
    scanBtn.textContent = state.scanning ? "Scanning…" : "Scan Page";
  }

  if (summary && status && summaryChars) {
    summary.hidden = !(state.scanning || state.scanned || Boolean(state.error));
    if (state.error) {
      status.textContent = state.error.userMessage;
      status.classList.add("status--error");
      summaryChars.textContent = "";
    } else if (state.scanning) {
      status.textContent = "Scanning visible text…";
      status.classList.remove("status--error");
      summaryChars.textContent = "";
    } else if (state.scanned) {
      summaryChars.textContent = `${state.visibleChars.toLocaleString()} characters analyzed`;
      status.textContent = state.truncated
        ? "Page was large; results may be partial."
        : "Analysis completed securely on this device.";
      status.classList.remove("status--error");
    } else {
      status.textContent = "";
      status.classList.remove("status--error");
    }
  }

  if (resultsSection) {
    resultsSection.hidden = !state.scanned;
    if (state.scanned) renderFindings(state.findings);
  }

  if (cloudNotice) {
    cloudNotice.hidden = state.mode !== "cloud" || !state.consentRequired;
    if (!cloudNotice.hidden) {
      cloudNotice.textContent =
        "Cloud analysis is disabled by default. No content leaves this device until you enable a gateway origin in settings.";
    }
  }

  const localRadio = document.getElementById("mode-local") as HTMLInputElement | null;
  const cloudRadio = document.getElementById("mode-cloud") as HTMLInputElement | null;
  if (localRadio && localRadio.checked !== (state.mode === "local")) localRadio.checked = state.mode === "local";
  if (cloudRadio && cloudRadio.checked !== (state.mode === "cloud")) cloudRadio.checked = state.mode === "cloud";
}

async function sendMessage(message: PopupMessage): Promise<void> {
  await chrome.runtime.sendMessage(message);
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
      CATEGORY_LABELS[f.category] ?? f.category,
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
      categoryLabel: CATEGORY_LABELS[f.category] ?? f.category,
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

function setDocStatus(message: string, isError: boolean): void {
  const status = document.getElementById("doc-status") as HTMLParagraphElement | null;
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("status--error", isError);
}

function renderDocStage(message: Extract<PopupFromWorker, { type: "POPUP_DOC_STATUS" }>): void {
  const list = document.getElementById("doc-stages") as HTMLElement | null;
  if (!list) return;
  list.hidden = false;
  const item = list.querySelector<HTMLElement>(`.stages__item[data-stage="${message.stage}"]`);
  if (!item) return;
  const detail = item.querySelector<HTMLElement>(".stages__detail");

  if (message.problem) {
    item.dataset.state = "failed";
    if (detail) detail.textContent = message.problem;
    return;
  }
  item.dataset.state = "done";
  if (!detail) return;
  if (message.stage === "detected") {
    detail.textContent = "";
  } else if (message.stage === "redacted") {
    detail.textContent =
      typeof message.paintedRegions === "number"
        ? `${message.paintedRegions} region${message.paintedRegions === 1 ? "" : "s"} blacked out`
        : "";
  } else {
    const verified = message.verifiedRegions ?? 0;
    const checked = message.checkedRegions ?? 0;
    const how = message.method === "page-pixels" ? "page bitmaps" : "the saved file";
    detail.textContent = checked > 0 ? `${verified} of ${checked} regions confirmed in ${how}` : "";
  }
}

function resetDocStages(): void {
  const list = document.getElementById("doc-stages") as HTMLElement | null;
  if (!list) return;
  list.hidden = true;
  for (const item of Array.from(list.querySelectorAll<HTMLElement>(".stages__item"))) {
    delete item.dataset.state;
    const detail = item.querySelector<HTMLElement>(".stages__detail");
    if (detail) detail.textContent = "";
  }
}

const overlayRedrawers: (() => void)[] = [];

function redrawAllOverlays(): void {
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
  if (!list) return;
  list.replaceChildren();
  if (!lastDoc) {
    updateDocRedactBtn();
    return;
  }
  for (const page of lastDoc.pages) {
    for (const finding of page.findings) {
      const item = el("li", "finding");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "finding__check";
      check.checked = selectedDocFindingIds.has(finding.id);
      check.setAttribute("aria-label", `Select ${CATEGORY_LABELS[finding.category] || finding.category} finding on page ${page.index + 1}`);
      check.addEventListener("change", () => {
        if (check.checked) selectedDocFindingIds.add(finding.id);
        else selectedDocFindingIds.delete(finding.id);
        updateDocRedactBtn();
        redrawAllOverlays();
      });

      const main = el("div", "finding__main");
      const head = el("div", "finding__head");
      const category = el("div", "finding__category", CATEGORY_LABELS[finding.category] || finding.category);
      head.append(category);
      if (finding.category === "custom") {
        const customBadge = el("span", "finding__badge-attr", "Custom Box");
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

  const review = document.getElementById("doc-review") as HTMLElement | null;
  const thumbs = document.getElementById("doc-thumbs") as HTMLElement | null;
  if (review) review.hidden = false;
  if (thumbs) {
    thumbs.replaceChildren();
    for (const page of state.pages) {
      const wrapper = el("div", "doc-thumb-wrapper");
      wrapper.setAttribute("title", "Click a finding to toggle, or click and drag to draw a custom redaction box");

      const img = document.createElement("img");
      img.src = page.previewDataUrl;
      img.alt = `Page ${page.index + 1}`;
      img.loading = "lazy";

      const canvas = document.createElement("canvas");
      canvas.className = "doc-thumb-overlay";
      canvas.setAttribute("aria-label", `Page ${page.index + 1} interactive redaction canvas`);

      wrapper.append(img, canvas);
      thumbs.appendChild(wrapper);

      let isDragging = false;
      let startX = 0;
      let startY = 0;
      let dragBox: { x: number; y: number; width: number; height: number } | null = null;

      const redraw = () => {
        const rect = wrapper.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width || img.naturalWidth || 120));
        const height = Math.max(1, Math.round(rect.height || img.naturalHeight || 160));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const scaleX = canvas.width / (page.widthPx || canvas.width || 1);
        const scaleY = canvas.height / (page.heightPx || canvas.height || 1);

        for (const finding of page.findings) {
          const isSelected = selectedDocFindingIds.has(finding.id);
          for (const r of finding.rects) {
            const rx = r.x * scaleX;
            const ry = r.y * scaleY;
            const rw = r.width * scaleX;
            const rh = r.height * scaleY;

            if (isSelected) {
              ctx.fillStyle = finding.category === "custom" ? "rgba(239, 68, 68, 0.45)" : "rgba(15, 23, 42, 0.75)";
              ctx.fillRect(rx, ry, rw, rh);
              ctx.strokeStyle = finding.category === "custom" ? "rgba(239, 68, 68, 0.95)" : "rgba(34, 211, 238, 0.9)";
              ctx.lineWidth = 1.5;
              ctx.setLineDash([]);
              ctx.strokeRect(rx, ry, rw, rh);
            } else {
              ctx.strokeStyle = "rgba(148, 163, 184, 0.6)";
              ctx.lineWidth = 1;
              ctx.setLineDash([3, 3]);
              ctx.strokeRect(rx, ry, rw, rh);
              ctx.setLineDash([]);
            }
          }
        }

        if (dragBox) {
          ctx.fillStyle = "rgba(34, 211, 238, 0.25)";
          ctx.fillRect(dragBox.x, dragBox.y, dragBox.width, dragBox.height);
          ctx.strokeStyle = "rgba(34, 211, 238, 0.95)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 2]);
          ctx.strokeRect(dragBox.x, dragBox.y, dragBox.width, dragBox.height);
          ctx.setLineDash([]);
        }
      };

      overlayRedrawers.push(redraw);
      img.addEventListener("load", redraw);
      window.addEventListener("resize", redraw);

      canvas.addEventListener("mousedown", (e) => {
        const bcr = canvas.getBoundingClientRect();
        const mouseX = (e.clientX - bcr.left) * (canvas.width / (bcr.width || 1));
        const mouseY = (e.clientY - bcr.top) * (canvas.height / (bcr.height || 1));

        const scaleX = canvas.width / (page.widthPx || canvas.width || 1);
        const scaleY = canvas.height / (page.heightPx || canvas.height || 1);
        const pageX = mouseX / scaleX;
        const pageY = mouseY / scaleY;

        let hitFinding: Finding | null = null;
        for (let i = page.findings.length - 1; i >= 0; i--) {
          const f = page.findings[i];
          for (const r of f.rects) {
            if (pageX >= r.x && pageX <= r.x + r.width && pageY >= r.y && pageY <= r.y + r.height) {
              hitFinding = f;
              break;
            }
          }
          if (hitFinding) break;
        }

        if (hitFinding) {
          if (selectedDocFindingIds.has(hitFinding.id)) {
            selectedDocFindingIds.delete(hitFinding.id);
          } else {
            selectedDocFindingIds.add(hitFinding.id);
          }
          renderDocFindings();
          redrawAllOverlays();
          return;
        }

        isDragging = true;
        startX = mouseX;
        startY = mouseY;
        dragBox = { x: mouseX, y: mouseY, width: 0, height: 0 };
        redraw();
      });

      canvas.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        const bcr = canvas.getBoundingClientRect();
        const curX = (e.clientX - bcr.left) * (canvas.width / (bcr.width || 1));
        const curY = (e.clientY - bcr.top) * (canvas.height / (bcr.height || 1));

        dragBox = {
          x: Math.min(startX, curX),
          y: Math.min(startY, curY),
          width: Math.abs(curX - startX),
          height: Math.abs(curY - startY),
        };
        redraw();
      });

      const finishDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        if (dragBox && dragBox.width > 4 && dragBox.height > 4) {
          const scaleX = canvas.width / (page.widthPx || canvas.width || 1);
          const scaleY = canvas.height / (page.heightPx || canvas.height || 1);
          const customRect: Rect = {
            x: Math.round(dragBox.x / scaleX),
            y: Math.round(dragBox.y / scaleY),
            width: Math.round(dragBox.width / scaleX),
            height: Math.round(dragBox.height / scaleY),
          };
          const customId = `custom:${requestId()}`;
          const customFinding: Finding = {
            id: customId,
            category: "custom",
            confidence: 1.0,
            source: "custom-pattern",
            preview: "[Custom Redaction]",
            nodeId: "",
            startOffset: 0,
            endOffset: 0,
            rects: [customRect],
            contextPreview: `Drawn bounding box (${customRect.width}×${customRect.height}px)`,
            selected: true,
          };
          page.findings.push(customFinding);
          selectedDocFindingIds.add(customId);
          renderDocFindings();
        }
        dragBox = null;
        redraw();
      };

      canvas.addEventListener("mouseup", finishDrag);
      canvas.addEventListener("mouseleave", finishDrag);

      setTimeout(redraw, 0);
    }
  }
  renderDocFindings();
  redrawAllOverlays();
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
  const review = document.getElementById("doc-review") as HTMLElement | null;
  const thumbs = document.getElementById("doc-thumbs") as HTMLElement | null;
  const list = document.getElementById("doc-findings") as HTMLUListElement | null;
  const redactBtn = document.getElementById("doc-redact-btn") as HTMLButtonElement | null;
  if (lastDoc) void deleteFile(lastDoc.fileKey).catch(() => undefined);
  lastDoc = null;
  selectedDocFindingIds.clear();
  overlayRedrawers.length = 0;
  if (review) review.hidden = true;
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

  // Wire contextual help links
  const helpLinks = document.querySelectorAll<HTMLElement>("[data-guide]");
  helpLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const guideId = link.getAttribute("data-guide");
      if (!guideId) return;
      switchTab("instructions");
      const targetEl = document.getElementById(guideId);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
        targetEl.classList.remove("guide-card--highlight");
        void targetEl.offsetWidth; // Force reflow
        targetEl.classList.add("guide-card--highlight");
      }
    });
  });
}

/** Shared popup/panel bootstrap. */
export async function initPopup(): Promise<void> {
  initTabs();

  const settings = await loadSettings();
  await renderCategories(settings);

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

  const docFile = document.getElementById("doc-file") as HTMLInputElement | null;
  const docRedactBtn = document.getElementById("doc-redact-btn") as HTMLButtonElement | null;
  const docClearBtn = document.getElementById("doc-clear-btn") as HTMLButtonElement | null;
  const docConfirmDialog = document.getElementById("doc-confirm-dialog") as HTMLDialogElement | null;
  const docCancel = document.getElementById("doc-cancel") as HTMLButtonElement | null;
  const docConfirm = document.getElementById("doc-confirm") as HTMLButtonElement | null;

  let lastState: PopupState | null = null;

  scanBtn?.addEventListener("click", () => {
    const mode: ScanMode = lastState?.mode ?? settings.mode;
    void sendMessage({ type: "POPUP_SCAN", requestId: requestId(), mode });
  });

  clearDataBtn?.addEventListener("click", () => {
    void sendMessage({ type: "POPUP_CLEAR_DATA", requestId: requestId() });
  });

  document.getElementById("open-side-panel-btn")?.addEventListener("click", async () => {
    try {
      const windowId = (await chrome.windows.getCurrent()).id;
      if (windowId != null) await chrome.sidePanel.open({ windowId });
    } catch {
      // Ignored
    }
  });

  applyMasksBtn?.addEventListener("click", () => {
    if (!lastState) return;
    void sendMessage({ type: "POPUP_APPLY_MASKS", requestId: requestId(), findingIds: currentSelectedIds(lastState) });
  });

  removeMasksBtn?.addEventListener("click", () => {
    void sendMessage({ type: "POPUP_REMOVE_MASKS", requestId: requestId() });
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
      void sendMessage({ type: "POPUP_DOC_PREVIEW", requestId: requestId(), fileKey, name: file.name, mimeType, kind });
    } catch (error) {
      await deleteFile(fileKey).catch(() => undefined);
      docFile.value = "";
      setDocStatus(error instanceof Error ? error.message : "Could not read this file.", true);
    }
  });

  const docStyleSelect = document.getElementById("doc-style-select") as HTMLSelectElement | null;
  const docStampContainer = document.getElementById("doc-stamp-container") as HTMLDivElement | null;
  const docStampText = document.getElementById("doc-stamp-text") as HTMLInputElement | null;
  const ocrLangSelect = document.getElementById("ocr-language-select") as HTMLSelectElement | null;

  if (ocrLangSelect) {
    ocrLangSelect.value = settings.ocrLanguage || "eng";
    ocrLangSelect.addEventListener("change", async () => {
      const current = await loadSettings();
      await saveSettings({ ...current, ocrLanguage: ocrLangSelect.value });
    });
  }

  if (docStyleSelect) {
    docStyleSelect.addEventListener("change", () => {
      if (docStampContainer) {
        docStampContainer.hidden = docStyleSelect.value !== "stamp";
      }
    });
  }

  docRedactBtn?.addEventListener("click", () => {
    if (!lastDoc || selectedDocFindingIds.size === 0) return;
    docConfirmDialog?.showModal();
  });

  docCancel?.addEventListener("click", () => docConfirmDialog?.close());

  docConfirm?.addEventListener("click", () => {
    docConfirmDialog?.close();
    if (!lastDoc) return;
    const boxes = buildDocBoxes();
    const ids = [...selectedDocFindingIds];
    if (boxes.length === 0) return;
    setDocStatus("Preparing redacted copy…", false);
    const style = (docStyleSelect?.value as RedactionStyle) || "blackout";
    const stampText = docStampText?.value?.trim() || "[REDACTED]";
    void sendMessage({
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
        padding: settings.maskPadding,
      },
    });
  });

  docClearBtn?.addEventListener("click", () => {
    if (!lastDoc) return;
    void sendMessage({ type: "POPUP_DOC_CLEAR", requestId: requestId(), docId: lastDoc.docId });
    clearDocUi();
    setDocStatus("", false);
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
        void sendMessage({ type: "POPUP_DOC_PREVIEW", requestId: requestId(), fileKey, name: file.name, mimeType, kind });
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

  const placeholderToggle = document.getElementById("placeholder-toggle") as HTMLInputElement | null;
  if (placeholderToggle) {
    placeholderToggle.checked = settings.maskPlaceholders;
    placeholderToggle.addEventListener("change", async () => {
      const current = await loadSettings();
      await saveSettings({ ...current, maskPlaceholders: placeholderToggle.checked });
    });
  }

  const pasteGuardToggle = document.getElementById("paste-guard-toggle") as HTMLInputElement | null;
  if (pasteGuardToggle) {
    pasteGuardToggle.checked = settings.pasteGuardEnabled;
    pasteGuardToggle.addEventListener("change", async () => {
      const current = await loadSettings();
      await saveSettings({ ...current, pasteGuardEnabled: pasteGuardToggle.checked });
    });
  }

  document.getElementById("export-audit-btn")?.addEventListener("click", () => {
    void sendMessage({ type: "POPUP_EXPORT_AUDIT", requestId: requestId() });
  });

  // ---------- Notifications & Account Settings ----------
  const notificationsToggle = document.getElementById("notifications-toggle") as HTMLInputElement | null;
  const notificationsStatus = document.getElementById("notifications-status") as HTMLParagraphElement | null;
  if (notificationsToggle) {
    notificationsToggle.checked = settings.notificationsEnabled;
    notificationsToggle.addEventListener("change", () => {
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

  purchaseBtn?.addEventListener("click", () => {
    if (accountStatus) accountStatus.textContent = "Opening Stripe checkout…";
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
      alert("Please provide at least one positive example.");
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

  chrome.runtime.onMessage.addListener((raw: unknown) => {
    const validation = validateMessage(raw);
    if (!validation.ok) return;
    const message = validation.message;
    if (message.type === "POPUP_STATE") {
      lastState = message.state;
      renderState(lastState);
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
    if (message.type === "POPUP_DOC_STATE") {
      const doc = lastDoc ?? {
        docId: message.docId,
        fileKey: message.fileKey,
        name: message.name,
        mimeType: message.mimeType,
        kind: message.kind,
        pages: [],
      };
      doc.docId = message.docId;
      doc.name = message.name;
      doc.fileKey = message.fileKey;
      doc.mimeType = message.mimeType;
      doc.kind = message.kind;
      doc.pages = message.pages;
      renderDoc(doc);
      const found = message.pages.reduce((n, p) => n + p.findings.length, 0);
      renderDocStage({
        type: "POPUP_DOC_STATUS",
        requestId: message.requestId,
        stage: "detected",
        problem: found === 0 ? "No sensitive values were found in this document." : undefined,
      });
      return;
    }
    if (message.type === "POPUP_DOC_DONE") {
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

          setDocStatus(`Downloaded ${message.outputName}. The original file was not changed.`, false);
        } catch {
          reportDelivery(false);
          setDocStatus(`Could not save ${message.outputName}. The original file was not changed.`, true);
        }
      } else {
        setDocStatus(`Saved ${message.outputName}. The original file was not changed.`, false);
      }
      clearDocUi();
      return;
    }
    if (message.type === "POPUP_DOC_STATUS") {
      renderDocStage(message);
      return;
    }
    if (message.type === "POPUP_DOC_ERROR") {
      setDocStatus(message.userMessage, true);
      return;
    }
    if (message.type === "POPUP_NOTIFICATIONS_STATE") {
      if (notificationsToggle) notificationsToggle.checked = message.granted;
      if (notificationsStatus) {
        notificationsStatus.textContent = message.granted
          ? "Notifications enabled."
          : "Notifications permission denied.";
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
      if (accountStatus) accountStatus.textContent = "Stripe checkout opened in a new tab.";
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
              [...wizardProposalsContainer.children].forEach((c) => ((c as HTMLElement).style.borderColor = "var(--border)"));
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
        const matches = message.testResult.filter((result) => result.matched).length;
        if (matches > 0) {
          wizardTestResultsBox.textContent = `✓ Valid regex — ${matches} matches found in sample.`;
          wizardTestResultsBox.style.color = "#34d399";
        } else {
          wizardTestResultsBox.textContent = "No matches found in the sample.";
          wizardTestResultsBox.style.color = "#f87171";
        }
      }
      return;
    }
    if (message.type === "POPUP_COMMUNITY_CONTRIBUTE_RESULT") {
      if (message.success) {
        alert("Rule contributed successfully to the GovernWorld community!");
      } else {
        alert(`Contribution failed: ${message.error ?? "Unknown error"}`);
      }
      return;
    }
  });

  void sendMessage({ type: "POPUP_GET_STATE", requestId: requestId() });
  void chrome.runtime.sendMessage({ type: "POPUP_CUSTOM_PATTERNS_GET", requestId: requestId() });
  void chrome.runtime.sendMessage({ type: "POPUP_COMMUNITY_ACCOUNT_GET", requestId: requestId() });
}
