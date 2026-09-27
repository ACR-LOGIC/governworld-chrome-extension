// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { extractVisibleText, buildScanText, mapRange, buildRedactedText, maskCombinedRange, selectionCombinedSpan } from "./extract.js";
import type { RangeLike } from "./extract.js";
import { applySelectionExcludingAttrs, attributeAt, buildAttrScan, collectAttrRecords } from "./attrs.js";
import type { AttrScan } from "./attrs.js";
import { detect, maskValue, maskContext, placeholderLabelFor } from "./detect.js";
import { createOverlay } from "./overlay.js";
import type { OverlayController } from "./overlay.js";
import { initPasteGuard } from "./pasteGuard.js";
import { validateMessage } from "../shared/messages.js";
import type { Finding, FindingCategory, Rect, WorkerMessage } from "../shared/types.js";

/**
 * Content script (isolated world). Runs only after a deliberate user action
 * triggers injection via activeTab. Owns in-page state for the current scan
 * session and communicates with the service worker through validated messages.
 * The page's own DOM is only read; masks are drawn in a shadow-root overlay.
 */

const g = globalThis as unknown as Record<string, unknown>;
if (g.__gwRedactionContentLoaded !== true) {
  g.__gwRedactionContentLoaded = true;
  initPasteGuard();

  const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

  let sessionId: string | null = null;
  let nodeIds = new Map<string, Text>();
  let segments: Awaited<ReturnType<typeof extractVisibleText>>["segments"] = [];
  let segmentStarts: number[] = [];
  let segmentIndexById = new Map<string, number>();
  let combined = "";
  let attrScan: AttrScan | null = null;
  let findings: Finding[] = [];
  let overlay: OverlayController | null = null;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  let placeholdersEnabled = false;

  function clearSession() {
    sessionId = null;
    nodeIds.clear();
    segments = [];
    segmentStarts = [];
    segmentIndexById.clear();
    combined = "";
    attrScan = null;
    findings = [];
    placeholdersEnabled = false;
    overlay?.clear();
    overlay?.destroy();
    overlay = null;
    if (sessionTimer) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
  }

  function touchSession() {
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      if (sessionId) clearSession();
    }, SESSION_TIMEOUT_MS);
  }

  function contextFor(start: number, end: number): string | undefined {
    const pad = 120;
    const from = Math.max(0, start - pad);
    const to = Math.min(combined.length, end + pad);
    const slice = combined.slice(from, to);
    return maskContext(slice);
  }

  function findingRects(start: number, end: number): Rect[] {
    const ranges = mapRange(segments, segmentStarts, combined.length, start, end);
    const rects: Rect[] = [];
    for (const range of ranges) {
      const node = nodeIds.get(range.nodeId);
      if (!node || !node.isConnected) continue;
      try {
        const domRange = document.createRange();
        domRange.setStart(node, range.startOffset);
        domRange.setEnd(node, range.endOffset);
        for (const r of domRange.getClientRects()) {
          rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
        }
      } catch {
        // Node partially detached between scan and render; skip safely.
      }
    }
    return rects;
  }

  function buildFindings(
    rawMatches: ReturnType<typeof detect>,
    enabledCategories: string[],
    customPatterns: any[] = []
  ): Finding[] {
    return rawMatches.map((match, i) => {
      const rects = findingRects(match.start, match.end);
      const mapped = mapRange(segments, segmentStarts, combined.length, match.start, match.end);
      const isCustom = match.category === "custom" || customPatterns.some((cp) => cp.category === match.category && cp.pattern);
      return {
        id: `${match.category}_${match.start}_${match.end}_${i}`,
        category: match.category,
        confidence: match.confidence,
        source: isCustom ? "custom-pattern" : "local-rules",
        preview: maskValue(match.category, match.value),
        nodeId: mapped[0]?.nodeId ?? "",
        startOffset: match.start,
        endOffset: match.end,
        rects,
        contextPreview: contextFor(match.start, match.end),
        selected: true,
      } satisfies Finding;
    });
  }

  function recomputeOverlay(padding: number) {
    if (!overlay) overlay = createOverlay(document);
    const items: Array<{ kind: "highlight" | "mask"; label: string; placeholder?: string; x: number; y: number; width: number; height: number }> = [];
    for (const finding of findings) {
      if (!finding.selected) continue;
      for (const r of finding.rects) {
        items.push({
          kind: "mask",
          label: `${finding.category}: ${finding.preview}`,
          ...(placeholdersEnabled ? { placeholder: placeholderLabelFor(finding.category) } : {}),
          x: r.x - padding,
          y: r.y - padding,
          width: r.width + padding * 2,
          height: r.height + padding * 2,
        });
      }
    }
    overlay.render(items);
  }

  async function handleScan(mode: "local" | "cloud", requestId: string, settings: ScanSettings): Promise<void> {
    if (mode === "cloud") {
      respond(
        {
          type: "CONTENT_ERROR",
          requestId,
          sessionId: sessionId as string,
          code: "CLOUD_NOT_ALLOWED",
          userMessage: "Cloud scanning is disabled. Switch to local mode in settings.",
        },
        requestId
      );
      return;
    }

    const extracted = extractVisibleText(
      document,
      settings.maxVisibleChars,
      settings.maxNodeChars,
      nodeIds
    );
    placeholdersEnabled = settings.maskPlaceholders;
    segments = extracted.segments;
    segmentIndexById.clear();
    for (let i = 0; i < segments.length; i++) segmentIndexById.set(segments[i].nodeId, i);
    const built = buildScanText(segments);
    combined = built.combined;
    segmentStarts = built.segmentStarts;

    let customPatterns: any[] = [];
    try {
      const stored = await chrome.storage.local.get("customPatterns");
      if (Array.isArray(stored.customPatterns)) {
        customPatterns = stored.customPatterns;
      }
    } catch {
      // Local storage read failed, fall back to empty
    }

    const rawMatches = detect(combined, settings.enabledCategories, customPatterns);
    findings = buildFindings(rawMatches, settings.enabledCategories, customPatterns);

    // Accessibility-surface pass (report-only): scan aria-label/alt/placeholder/
    // title values. Read-only; these findings are never maskable.
    let attrChars = 0;
    try {
      const collected = collectAttrRecords(document, {
        maxTotalChars: settings.maxVisibleChars,
        maxPerValue: Math.min(settings.maxNodeChars, 2048),
      });
      attrScan = buildAttrScan(collected.records);
      attrChars = attrScan.combined.length;
      const attrMatches = detect(attrScan.combined, settings.enabledCategories, customPatterns);
      const attrFindings = attrMatches.map((match, i) => {
        const value = attrScan!.combined.slice(match.start, match.end);
        const pad = 120;
        const ctxSlice = attrScan!.combined.slice(Math.max(0, match.start - pad), Math.min(attrScan!.combined.length, match.end + pad));
        return {
          id: `attr_${match.category}_${match.start}_${match.end}_${i}`,
          category: match.category,
          confidence: match.confidence,
          source: "attr" as const,
          preview: maskValue(match.category, value),
          nodeId: "",
          startOffset: match.start,
          endOffset: match.end,
          rects: [],
          contextPreview: maskContext(ctxSlice),
          attribute: attributeAt(attrScan!, match.start),
          selected: false,
        } satisfies Finding;
      });
      findings = [...findings, ...attrFindings];
    } catch {
      // Attribute collection is best-effort reporting; never fail the scan.
      attrScan = null;
    }
    touchSession();

    const result: Finding[] = findings.map((f) => ({
      ...f,
      rects: f.rects.map((r) => ({ ...r })),
    }));
    respond(
      {
        type: "SCAN_RESULT",
        requestId,
        sessionId: sessionId as string,
        findings: result,
        stats: { visibleChars: combined.length, attrChars, truncated: extracted.truncated },
      },
      requestId
    );
  }

  function respond(message: unknown, requestId: string): void {
    void chrome.runtime.sendMessage(message).catch(() => {
      // SW may have suspended; delivery is best-effort for fire-and-forget.
    });
  }

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const validation = validateMessage(raw);
    if (!validation.ok) {
      sendResponse({ ok: false, error: validation.error });
      return;
    }
    const msg = validation.message as WorkerMessage;

    void (async () => {
      try {
        switch (msg.type) {
          case "SCAN_PAGE": {
            clearSession();
            sessionId = msg.sessionId;
            await handleScan(msg.mode, msg.requestId, msg.settings);
            sendResponse({ ok: true });
            break;
          }
          case "APPLY_MASKS": {
            if (msg.sessionId !== sessionId) {
              sendResponse({ ok: false, error: "Stale session" });
              break;
            }
            const idSet = new Set(msg.findingIds);
            findings = applySelectionExcludingAttrs(findings, idSet);
            recomputeOverlay(4);
            touchSession();
            sendResponse({ ok: true });
            break;
          }
          case "REMOVE_MASKS": {
            if (msg.sessionId !== sessionId) {
              sendResponse({ ok: false, error: "Stale session" });
              break;
            }
            findings = findings.map((f) => ({ ...f, selected: false }));
            overlay?.clear();
            touchSession();
            sendResponse({ ok: true });
            break;
          }
          case "COPY_REDACTED_TEXT": {
            if (msg.sessionId !== sessionId) {
              sendResponse({ ok: false, error: "Stale session" });
              break;
            }
            const idSet = new Set(msg.findingIds);
            // Report-only attribute findings are never included in redacted copy.
            const selectedFindings = applySelectionExcludingAttrs(findings, idSet).filter(
              (f) => f.source !== "attr"
            );
            const text = buildRedactedText(segments, segmentStarts, combined.length, selectedFindings);
            respond(
              { type: "COPY_REDACTED_TEXT_RESULT", requestId: msg.requestId, sessionId, text },
              msg.requestId
            );
            touchSession();
            sendResponse({ ok: true });
            break;
          }
          case "CONTEXT_REDACT_SELECTION": {
            const selText = msg.selectionText ?? window.getSelection()?.toString() ?? "";
            if (!selText) {
              sendResponse({ ok: false, error: "No text selected" });
              break;
            }
            let customPatterns: any[] = [];
            try {
              const stored = await chrome.storage.local.get("customPatterns");
              if (Array.isArray(stored.customPatterns)) {
                customPatterns = stored.customPatterns;
              }
            } catch {
              // Ignore
            }
            const enabledCategories = msg.settings?.enabledCategories ?? [
              "email", "phone", "ssn", "dob", "medical_record_number",
              "member_id", "npi", "dea", "mbi", "address", "payment_card", "secrets", "possible_name"
            ];
            const matches = detect(selText, enabledCategories, customPatterns);
            let redacted = selText;
            const sorted = [...matches].sort((a, b) => b.start - a.start);
            for (const m of sorted) {
              const repl = msg.settings?.maskPlaceholders
                ? placeholderLabelFor(m.category)
                : "\u2588".repeat(m.end - m.start);
              redacted = redacted.slice(0, m.start) + repl + redacted.slice(m.end);
            }
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(redacted);
            }
            sendResponse({ ok: true, redactedText: redacted });
            break;
          }
          case "CONTEXT_MASK_SELECTION": {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
              sendResponse({ ok: false, error: "No active selection to mask" });
              break;
            }
            if (!overlay) overlay = createOverlay(document);
            placeholdersEnabled = msg.settings?.maskPlaceholders ?? false;
            const range = sel.getRangeAt(0);
            const rects = range.getClientRects();
            const items: Array<{ kind: "highlight" | "mask"; label: string; placeholder?: string; x: number; y: number; width: number; height: number }> = [];
            const padding = 4;
            for (const r of rects) {
              items.push({
                kind: "mask",
                label: "Selected text",
                ...(placeholdersEnabled ? { placeholder: "[REDACTED]" } : {}),
                x: r.x - padding,
                y: r.y - padding,
                width: r.width + padding * 2,
                height: r.height + padding * 2,
              });
            }
            overlay.render(items);
            touchSession();
            sendResponse({ ok: true });
            break;
          }
          default:
            sendResponse({ ok: false, error: "Unsupported content message" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  });

  /**
   * While a mask session is active, replace clipboard content with the
   * redacted form of the current selection so plain copy/cut cannot leak
   * masked values. The DOM is never mutated; the redacted text is derived
   * from the scan state. With no selected findings, copy behaves normally.
   */
  function onClipboard(event: ClipboardEvent): void {
    if (!sessionId) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0) as unknown as RangeLike<Text>;
    const span = selectionCombinedSpan(
      range,
      segments,
      segmentStarts,
      segmentIndexById,
      nodeIds,
      combined.length,
      (node) => node.isConnected
    );
    if (!span) return;
    const active = findings.filter(
      (f) => f.selected && f.startOffset < span.end && f.endOffset > span.start
    );
    if (active.length === 0) return;
    const text = maskCombinedRange(combined, span.start, span.end, active);
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    touchSession();
  }

  document.addEventListener("copy", onClipboard);
  // Intercepting cut also prevents the selection from being deleted from the
  // source page while masks are active.
  document.addEventListener("cut", onClipboard);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") clearSession();
  });

  const invalidateOnNavigation = () => clearSession();
  window.addEventListener("popstate", invalidateOnNavigation);
  const pushState = history.pushState;
  const replaceState = history.replaceState;
  history.pushState = function (...args: unknown[]) {
    pushState.apply(this, args as Parameters<typeof pushState>);
    invalidateOnNavigation();
  };
  history.replaceState = function (...args: unknown[]) {
    replaceState.apply(this, args as Parameters<typeof replaceState>);
    invalidateOnNavigation();
  };
}

interface ScanSettings {
  enabledCategories: FindingCategory[];
  maxVisibleChars: number;
  maxNodeChars: number;
  maskPlaceholders: boolean;
}