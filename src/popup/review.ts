// Full-screen document review.
//
// The popup's studio renders a page of text inside a ~360px column, so the words
// are about a tenth of natural size and a drawn redaction box lands on pixels
// nobody can read. This page shows the document at full size and puts every
// control in a side panel, which is the only way drawing is usable.
//
// It reuses the existing, verified pipeline: the popup stages the document and
// writes the session, this page reads it, and redaction goes back through the
// same POPUP_DOC_REDACT message an uploaded file uses. No second redaction
// implementation.

import { previewObjectUrl } from "../shared/docStore.js";
import type { DocKind, DocPageMeta, Finding, Rect, RedactionStyle, RedactionOptions } from "../shared/types.js";

const SESSION_KEY = "reviewSession";

interface ReviewFinding {
  id: string;
  category: string;
  preview: string;
  pageIndex: number;
  rects: Rect[];
  custom: boolean;
}

interface ReviewSession {
  docId: string;
  fileKey: string;
  name: string;
  mimeType: string;
  kind: DocKind;
  pages: DocPageMeta[];
  /** True when the bytes came from a screen capture rather than the original file. */
  degraded: boolean;
  source: "original" | "capture";
}

const el = <T extends HTMLElement>(id: string): T | null => (document.getElementById(id) as T | null);

const dom = {
  pages: el<HTMLDivElement>("pages"),
  stageStatus: el<HTMLParagraphElement>("stage-status"),
  docName: el<HTMLElement>("doc-name"),
  docPages: el<HTMLElement>("doc-pages"),
  notice: el<HTMLDivElement>("source-notice"),
  findings: el<HTMLUListElement>("findings"),
  findingsCount: el<HTMLElement>("findings-count"),
  selectAll: el<HTMLButtonElement>("select-all"),
  selectNone: el<HTMLButtonElement>("select-none"),
  clearDrawn: el<HTMLButtonElement>("clear-drawn"),
  undoDrawn: el<HTMLButtonElement>("undo-drawn"),
  style: el<HTMLSelectElement>("style"),
  stampRow: el<HTMLDivElement>("stamp-row"),
  stampText: el<HTMLInputElement>("stamp-text"),
  actionStatus: el<HTMLParagraphElement>("action-status"),
  close: el<HTMLButtonElement>("close"),
  redact: el<HTMLButtonElement>("redact"),
  confirm: el<HTMLDialogElement>("confirm"),
  confirmCancel: el<HTMLButtonElement>("confirm-cancel"),
  confirmGo: el<HTMLButtonElement>("confirm-go"),
};

let session: ReviewSession | null = null;
let findings: ReviewFinding[] = [];
const selected = new Set<string>();
/** Per-page redraw, so a style change repaints every sheet. */
const redrawers: (() => void)[] = [];

function setActionStatus(text: string, isError = false): void {
  if (!dom.actionStatus) return;
  dom.actionStatus.textContent = text;
  dom.actionStatus.classList.toggle("review__status--error", isError);
}

function currentStyle(): RedactionStyle {
  return (dom.style?.value as RedactionStyle) || "blackout";
}

function stampLabel(): string {
  return dom.stampText?.value?.trim() || "[REDACTED]";
}

/** Paint one region in the current style, shared by every sheet. */
function paintRect(ctx: CanvasRenderingContext2D, rect: Rect): void {
  const style = currentStyle();
  if (style === "blackout") {
    ctx.fillStyle = "#000000";
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    return;
  }
  if (style === "whiteout") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = "#cccccc";
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    return;
  }
  ctx.fillStyle = "#000000";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.fillStyle = "#ffffff";
  const fontSize = Math.max(10, Math.min(rect.height * 0.7, 16));
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(stampLabel(), rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width - 4);
}

function renderFindingsList(): void {
  if (!dom.findings) return;
  dom.findings.replaceChildren();
  if (dom.findingsCount) dom.findingsCount.textContent = String(findings.length);
  for (const finding of findings) {
    const li = document.createElement("li");
    li.className = "finding";
    li.classList.toggle("finding--report-only", !selected.has(finding.id));

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "finding__check";
    check.checked = selected.has(finding.id);
    check.addEventListener("change", () => {
      if (check.checked) selected.add(finding.id);
      else selected.delete(finding.id);
      li.classList.toggle("finding--report-only", !check.checked);
      if (dom.redact) dom.redact.disabled = selected.size === 0;
      for (const redraw of redrawers) redraw();
    });

    const label = document.createElement("label");
    label.className = "finding__main";
    const text = document.createElement("span");
    text.textContent = finding.preview;
    const meta = document.createElement("span");
    meta.className = "finding__severity";
    meta.textContent = finding.custom ? "Manual" : finding.category;
    label.append(text, meta);
    // The label is the hit target: a native checkbox at 14px is not clickable
    // enough to be a primary control on a large page.
    label.addEventListener("click", (e) => {
      e.preventDefault();
      check.checked = !check.checked;
      check.dispatchEvent(new Event("change"));
    });

    li.append(check, label);
    dom.findings.append(li);
  }
  if (dom.redact) dom.redact.disabled = selected.size === 0;
}

async function renderPages(): Promise<void> {
  if (!dom.pages || !session) return;
  dom.pages.replaceChildren();
  redrawers.length = 0;

  for (const page of session.pages) {
    const sheet = document.createElement("div");
    sheet.className = "review__sheet";

    const img = document.createElement("img");
    img.className = "review__pageimg";
    img.alt = `Page ${page.index + 1}`;
    try {
      const url = await previewObjectUrl(page.previewKey);
      if (url) img.src = url;
      else img.alt = `Page ${page.index + 1} (preview unavailable)`;
    } catch {
      img.alt = `Page ${page.index + 1} (preview unavailable)`;
    }

    // The canvas is the full-resolution render and the drawing surface. The
    // image underneath is the preview bitmap, which is deliberately small, so
    // the canvas is what the user draws on and what carries the boxes.
    const canvas = document.createElement("canvas");
    canvas.className = "review__overlay";
    canvas.width = page.widthPx;
    canvas.height = page.heightPx;

    const redraw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const finding of findings) {
        if (finding.pageIndex !== page.index) continue;
        if (!selected.has(finding.id)) continue;
        for (const rect of finding.rects) paintRect(ctx, rect);
      }
    };
    redrawers.push(redraw);
    redraw();

    // Drawing works in canvas pixels, converted from pointer position, so a
    // box stays correct at any zoom level or window size.
    let drawing = false;
    let startX = 0;
    let startY = 0;
    const toCanvas = (e: MouseEvent) => {
      const bounds = canvas.getBoundingClientRect();
      return {
        x: Math.round(((e.clientX - bounds.left) / bounds.width) * canvas.width),
        y: Math.round(((e.clientY - bounds.top) / bounds.height) * canvas.height),
      };
    };

    canvas.addEventListener("mousedown", (e) => {
      e.preventDefault();
      drawing = true;
      const { x, y } = toCanvas(e);
      startX = x;
      startY = y;
    });

    canvas.addEventListener("mousemove", (e) => {
      if (!drawing) return;
      const { x, y } = toCanvas(e);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      redraw();
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(Math.min(startX, x), Math.min(startY, y), Math.abs(x - startX), Math.abs(y - startY));
      ctx.setLineDash([]);
    });

    const finish = (e: MouseEvent) => {
      if (!drawing) return;
      drawing = false;
      const { x, y } = toCanvas(e);
      const rect: Rect = {
        x: Math.min(startX, x),
        y: Math.min(startY, y),
        width: Math.abs(x - startX),
        height: Math.abs(y - startY),
      };
      // A 6px floor in canvas pixels: below that it is a click, not a drag.
      if (rect.width < 6 || rect.height < 6) {
        // A click toggles whatever box is under the pointer.
        const hit = findings.find(
          (f) =>
            f.pageIndex === page.index &&
            f.rects.some((r) => rect.x >= r.x && rect.x <= r.x + r.width && rect.y >= r.y && rect.y <= r.y + r.height)
        );
        if (hit) {
          if (selected.has(hit.id)) selected.delete(hit.id);
          else selected.add(hit.id);
          renderFindingsList();
          for (const redraw of redrawers) redraw();
        }
        return;
      }
      // The id prefix is part of the contract, not decoration: the worker
      // validates every selected id against the session and only accepts an id
      // it does not recognise if it starts with "custom:" or "user:". A drawn
      // box using any other prefix is rejected at redaction time with "The
      // selected findings are no longer available."
      const custom: ReviewFinding = {
        id: `custom:${Date.now()}:${Math.round(rect.x)}:${Math.round(rect.y)}`,
        category: "custom",
        preview: `Custom area (${Math.round(rect.width)}x${Math.round(rect.height)})`,
        pageIndex: page.index,
        rects: [rect],
        custom: true,
      };
      findings.push(custom);
      selected.add(custom.id);
      renderFindingsList();
      for (const redraw of redrawers) redraw();
    };

    canvas.addEventListener("mouseup", finish);
    canvas.addEventListener("mouseleave", () => {
      if (drawing) {
        drawing = false;
        redraw();
      }
    });

    sheet.append(img, canvas);
    dom.pages.append(sheet);
  }
  for (const redraw of redrawers) redraw();
}

function loadSessionFromStorage(value: unknown): ReviewSession | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.docId !== "string" || typeof v.fileKey !== "string" || typeof v.name !== "string") return null;
  if (!Array.isArray(v.pages)) return null;
  return {
    docId: v.docId,
    fileKey: v.fileKey,
    name: v.name,
    mimeType: typeof v.mimeType === "string" ? v.mimeType : "application/octet-stream",
    kind: v.kind === "pdf" || v.kind === "docx" ? v.kind : "image",
    pages: v.pages as DocPageMeta[],
    degraded: v.degraded === true,
    source: v.source === "capture" ? "capture" : "original",
  };
}

async function hydrateFromSession(): Promise<void> {
  session = null;
  findings = [];
  selected.clear();
  for (const redraw of redrawers) redraw();

  let raw: Record<string, unknown> = {};
  try {
    raw = await chrome.storage.session.get(SESSION_KEY);
  } catch (error) {
    setActionStatus(error instanceof Error ? error.message : "The document could not be read.", true);
    if (dom.redact) dom.redact.disabled = true;
    return;
  }

  session = loadSessionFromStorage(raw[SESSION_KEY]);
  if (!session) {
    if (dom.stageStatus) dom.stageStatus.textContent = "That document is no longer available. Reopen it from the extension.";
    setActionStatus("No document to review.", true);
    if (dom.redact) dom.redact.disabled = true;
    return;
  }
  if (dom.docName) dom.docName.textContent = session.name;
  if (dom.docPages) dom.docPages.textContent = `${session.pages.length} page${session.pages.length === 1 ? "" : "s"}`;
  if (dom.stageStatus) dom.stageStatus.textContent = "";

  // State the limit of the source, because a screen capture OCRs worse than
  // the original file and the user must know which one they are looking at.
  if (dom.notice) {
    if (session.degraded) {
      dom.notice.hidden = false;
      dom.notice.textContent =
        "This image was captured from the screen, so detail is limited by the size it was displayed at. Zoom the page in and re-capture for better recognition.";
      dom.notice.classList.add("review__notice--warn");
    } else {
      dom.notice.hidden = true;
    }
  }

  for (const page of session.pages) {
    for (const f of page.findings as Finding[]) {
      findings.push({
        id: f.id,
        category: String(f.category),
        preview: String(f.preview ?? f.category),
        pageIndex: page.index,
        rects: f.rects.map((r) => ({ ...r })),
        custom: f.category === "custom",
      });
      if (f.selected !== false) selected.add(f.id);
    }
  }
  renderFindingsList();
  await renderPages();
}

function buildRequest(): { boxes: { pageIndex: number; rects: Rect[] }[]; findingIds: string[] } | null {
  if (!session) return null;
  const boxes: { pageIndex: number; rects: Rect[] }[] = [];
  const findingIds: string[] = [];
  for (const finding of findings) {
    if (!selected.has(finding.id)) continue;
    boxes.push({ pageIndex: finding.pageIndex, rects: finding.rects });
    findingIds.push(finding.id);
  }
  return { boxes, findingIds };
}

/**
 * Ask the worker to redact.
 *
 * The worker answers `{ ok: false, error }` for a refusal, so the response is
 * treated as untrusted: a redaction that reports failure must never be reported
 * to the user as a saved file.
 */
async function sendRedactRequest(
  doc: ReviewSession,
  built: { boxes: { pageIndex: number; rects: Rect[] }[]; findingIds: string[] },
  options: RedactionOptions
): Promise<{ ok?: boolean; error?: string }> {
  try {
    return (await chrome.runtime.sendMessage({
      type: "POPUP_DOC_REDACT",
      requestId: crypto.randomUUID(),
      docId: doc.docId,
      fileKey: doc.fileKey,
      name: doc.name,
      mimeType: doc.mimeType,
      kind: doc.kind,
      boxes: built.boxes,
      findingIds: built.findingIds,
      options,
    })) as { ok?: boolean; error?: string };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function requestRedaction(): Promise<void> {
  if (!session) return;
  const built = buildRequest();
  if (!built || built.findingIds.length === 0) {
    setActionStatus("Select at least one area to redact.", true);
    return;
  }
  setActionStatus("Preparing your redacted copy...");
  if (dom.redact) dom.redact.disabled = true;
  const options: RedactionOptions = {
    style: currentStyle(),
    stampText: stampLabel(),
    padding: 2,
    fillColor: "#000000",
  };
  const reply = await sendRedactRequest(session, built, options);
  // The worker answers { ok: false, error } for a refusal. Treat the response
  // shape as untrusted: a redaction that reports failure must not read as a
  // saved file.
  if (reply?.ok === true) {
    setActionStatus("Saved. The original file was not changed.");
  } else {
    setActionStatus(reply?.error ? String(reply.error) : "The redaction could not be completed.", true);
  }
  if (dom.redact) dom.redact.disabled = selected.size === 0;
}

function wire(): void {
  dom.selectAll?.addEventListener("click", () => {
    for (const f of findings) selected.add(f.id);
    renderFindingsList();
    for (const redraw of redrawers) redraw();
  });
  dom.selectNone?.addEventListener("click", () => {
    selected.clear();
    renderFindingsList();
    for (const redraw of redrawers) redraw();
  });
  dom.clearDrawn?.addEventListener("click", () => {
    for (const id of [...selected]) {
      const finding = findings.find((f) => f.id === id);
      if (finding?.custom) selected.delete(id);
    }
    findings = findings.filter((f) => !f.custom);
    renderFindingsList();
    for (const redraw of redrawers) redraw();
  });
  dom.undoDrawn?.addEventListener("click", () => {
    for (let i = findings.length - 1; i >= 0; i--) {
      if (findings[i].custom) {
        selected.delete(findings[i].id);
        findings.splice(i, 1);
        break;
      }
    }
    renderFindingsList();
    for (const redraw of redrawers) redraw();
  });
  dom.style?.addEventListener("change", () => {
    if (dom.stampRow) dom.stampRow.hidden = currentStyle() !== "stamp";
    for (const redraw of redrawers) redraw();
  });
  dom.stampText?.addEventListener("input", () => {
    for (const redraw of redrawers) redraw();
  });
  dom.redact?.addEventListener("click", () => dom.confirm?.showModal());
  dom.confirmCancel?.addEventListener("click", () => dom.confirm?.close());
  dom.confirmGo?.addEventListener("click", () => {
    dom.confirm?.close();
    void requestRedaction();
  });
  dom.close?.addEventListener("click", () => window.close());

  // The worker broadcasts progress and completion; reflect it here so the page
  // is not a silent black box while a redaction runs.
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return;
    const message = raw as { type?: string; userMessage?: string; outputName?: string; problem?: string };
    if (message.type === "POPUP_DOC_STATUS" && message.problem) {
      setActionStatus(message.problem, true);
    } else if (message.type === "POPUP_DOC_ERROR" && message.userMessage) {
      setActionStatus(message.userMessage, true);
      if (dom.redact) dom.redact.disabled = false;
    } else if (message.type === "POPUP_DOC_DONE" && message.outputName) {
      setActionStatus(`Saved ${message.outputName}. The original was not changed.`);
      if (dom.redact) dom.redact.disabled = false;
    }
  });
}

wire();
void hydrateFromSession();
