// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { extractVisibleText, buildScanText, mapRange, buildRedactedText, maskCombinedRange, selectionCombinedSpan } from "./extract.js";
import type { RangeLike } from "./extract.js";
import { isExcludedElement } from "./extract.js";
import { applySelectionExcludingAttrs, attributeAt, buildAttrScan, collectAttrRecords } from "./attrs.js";
import type { AttrScan } from "./attrs.js";
import { detect, maskValue, maskContext, placeholderLabelFor } from "./detect.js";
import { createOverlay } from "./overlay.js";
import type { OverlayController } from "./overlay.js";
import { initPasteGuard } from "./pasteGuard.js";
import { validateMessage } from "../shared/messages.js";
import type { Finding, FindingCategory, Rect, WorkerMessage } from "../shared/types.js";
import { buildCanonicalDocument } from "./normalization/canonical.js";
import { observeMutations, getAffectedNodeIds, type MutationObserverHandle, type MutationBatch } from "./normalization/mutation.js";
import { formatCoverageSummary, setDynamicContentMonitored } from "./normalization/coverage.js";
import { traverseIframes } from "./normalization/iframe.js";
import { extractTableStructures, annotateSegmentsWithTableStructure } from "./normalization/table.js";

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

  const DEFAULT_SESSION_TIMEOUT_MS = 15 * 60 * 1000;
  let activeSessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS;

  let sessionId: string | null = null;
  let nodeIds = new Map<string, Node>();
  let segments: import("./normalization/types.js").CanonicalSegment[] = [];
  let segmentStarts: number[] = [];
  let segmentIndexById = new Map<string, number>();
  let combined = "";
  let attrScan: AttrScan | null = null;
  let findings: Finding[] = [];
  let overlay: OverlayController | null = null;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  let placeholdersEnabled = false;
  let currentSettings: ScanSettings | null = null;
  let currentCustomPatterns: any[] = [];

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
    if (activeSessionTimeoutMs <= 0) return;
    sessionTimer = setTimeout(() => {
      if (sessionId) clearSession();
    }, activeSessionTimeoutMs);
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
        if (node.nodeType === Node.TEXT_NODE) {
          const domRange = document.createRange();
          domRange.setStart(node, range.startOffset);
          domRange.setEnd(node, range.endOffset);
          for (const r of domRange.getClientRects()) {
            rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const r = (node as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
          }
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
    const sessionTimeoutMs = settings.sessionTimeoutMs;
    activeSessionTimeoutMs = sessionTimeoutMs;
    currentSettings = settings;

    const canonical = buildCanonicalDocument({
      root: document,
      sourceKind: "web-dom",
      maxVisibleChars: settings.maxVisibleChars,
      maxNodeChars: settings.maxNodeChars,
      nodeIds,
    });

    const tables = extractTableStructures(document);
    if (tables.length > 0) {
      canonical.segments = annotateSegmentsWithTableStructure(canonical.segments, tables);
      canonical.metadata.tableCount = tables.length;
    }

    const iframeResult = traverseIframes(document, {
      maxVisibleChars: settings.maxVisibleChars,
      maxNodeChars: settings.maxNodeChars,
      nodeIds,
    });
    if (iframeResult.frameDocuments.length > 0) {
      for (const frameDoc of iframeResult.frameDocuments) {
        canonical.segments.push(...frameDoc.segments);
        canonical.combined += "\n" + frameDoc.combined;
        canonical.segmentStarts.push(...frameDoc.segmentStarts.map((s) => s + canonical.combined.length - frameDoc.combined.length));
      }
      canonical.boundaries.push(...iframeResult.boundaries);
      canonical.coverage = {
        ...canonical.coverage,
        sameOriginFrames: "complete",
        totalBoundaries: canonical.boundaries.length,
        inaccessibleBoundaries: canonical.coverage.inaccessibleBoundaries + iframeResult.boundaries.filter((b) => b.status === "inaccessible").length,
      };
    }

    canonical.coverage = setDynamicContentMonitored(canonical.coverage);

    segments = canonical.segments;
    combined = canonical.combined;
    segmentStarts = canonical.segmentStarts;
    segmentIndexById.clear();
    for (let i = 0; i < segments.length; i++) segmentIndexById.set(segments[i].nodeId, i);

    placeholdersEnabled = settings.maskPlaceholders;

    let customPatterns: any[] = [];
    try {
      const stored = await chrome.storage.local.get("customPatterns");
      if (Array.isArray(stored.customPatterns)) {
        customPatterns = stored.customPatterns;
      }
    } catch {
      // Local storage read failed, fall back to empty
    }
    currentCustomPatterns = customPatterns;

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
        stats: {
          visibleChars: combined.length,
          attrChars,
          truncated: canonical.truncated,
          // When there is no text to scan, the page's images are what the user
          // almost certainly meant to protect. Reporting them lets the popup
          // offer OCR over the real file instead of silently finding nothing.
          ...(combined.length === 0 ? { imageCandidates: collectImageCandidates() } : {}),
        },
      },
      requestId
    );
  }

  /**
   * List the page's images so a textless page can still be protected.
   *
   * Only images that actually carry pixels are reported, ranked largest first,
   * and the list is capped: a gallery page can hold thousands of thumbnails and
   * none of them are the document. `sameOrigin` marks the images this page is
   * allowed to read directly, which is what decides whether the original file
   * can be used or a rendered capture is needed.
   */
  function collectImageCandidates(): Array<{ src: string; width: number; height: number; sameOrigin: boolean }> {
    const found: Array<{ src: string; width: number; height: number; sameOrigin: boolean; pixels: number }> = [];
    let images: HTMLImageElement[];
    try {
      images = Array.from(document.querySelectorAll("img"));
    } catch {
      return [];
    }
    for (const img of images) {
      if (isExcludedElement(img)) continue;
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;
      // Below this the image cannot hold readable text; it is an icon.
      if (width * height < 40_000) continue;
      const src = img.currentSrc || img.src || "";
      if (!src) continue;
      let sameOrigin = false;
      try {
        sameOrigin = new URL(src, location.href).origin === location.origin;
      } catch {
        continue;
      }
      found.push({ src: src.slice(0, 2048), width, height, sameOrigin, pixels: width * height });
    }
    found.sort((a, b) => b.pixels - a.pixels);
    return found.slice(0, 12).map(({ src, width, height, sameOrigin }) => ({ src, width, height, sameOrigin }));
  }

  function respond(message: unknown, requestId: string): void {
    void chrome.runtime.sendMessage(message).catch(() => {
      // SW may have suspended; delivery is best-effort for fire-and-forget.
    });
  }

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "PING") {
      sendResponse({ ok: true, status: "ready" });
      return true;
    }

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

  let mutationObserver: MutationObserverHandle | null = null;
  let pendingMutationBatch: MutationBatch | null = null;
  let mutationDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  function rescanAffectedRegions(batch: MutationBatch): void {
    if (!sessionId || !currentSettings) return;

    const affectedNodeIds = getAffectedNodeIds(batch, nodeIds);
    if (affectedNodeIds.size === 0 && batch.addedNodes.length === 0) return;

    const findingsToRemove = new Set<string>();
    for (const finding of findings) {
      if (finding.nodeId && affectedNodeIds.has(finding.nodeId)) {
        findingsToRemove.add(finding.id);
      }
    }
    if (findingsToRemove.size > 0) {
      findings = findings.filter((f) => !findingsToRemove.has(f.id));
    }

    for (const nodeId of affectedNodeIds) {
      const idx = segmentIndexById.get(nodeId);
      if (idx !== undefined) {
        segments.splice(idx, 1);
        nodeIds.delete(nodeId);
        segmentIndexById.delete(nodeId);
      }
    }

    for (const node of batch.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
        const newNodeIds = new Map<string, Node>();
        const extracted = extractVisibleText(
          node as Element,
          currentSettings.maxVisibleChars,
          currentSettings.maxNodeChars,
          newNodeIds
        );
        if (extracted.segments.length > 0) {
          const newBuilt = buildScanText(extracted.segments);
          const offset = combined.length > 0 ? combined.length + 1 : 0;
          for (let i = 0; i < extracted.segments.length; i++) {
            const seg = extracted.segments[i];
            const newSeg: import("./normalization/types.js").CanonicalSegment = {
              nodeId: `rescan_${seg.nodeId}`,
              startOffset: seg.startOffset,
              endOffset: seg.endOffset,
              text: seg.text,
              combinedStartOffset: offset + newBuilt.segmentStarts[i],
              combinedEndOffset: offset + newBuilt.segmentStarts[i] + seg.text.length,
            };
            segments.push(newSeg);
            nodeIds.set(newSeg.nodeId, node as Node);
            segmentIndexById.set(newSeg.nodeId, segments.length - 1);
          }
          combined += (combined.length > 0 ? "\n" : "") + newBuilt.combined;
          segmentStarts.push(...newBuilt.segmentStarts.map((s) => s + offset));
        }
      }
    }

    if (segments.length > 0) {
      const rawMatches = detect(combined, currentSettings.enabledCategories, currentCustomPatterns);
      const newFindings = buildFindings(rawMatches, currentSettings.enabledCategories, currentCustomPatterns);
      const existingIds = new Set(findings.map((f) => f.id));
      for (const nf of newFindings) {
        if (!existingIds.has(nf.id)) {
          findings.push(nf);
        }
      }
    }

    if (findings.some((f) => f.selected)) {
      recomputeOverlay(4);
    }
  }

  function startMutationObserver(): void {
    if (mutationObserver) return;
    mutationObserver = observeMutations(document, (batch) => {
      if (!sessionId) return;

      const affectedCount = batch.addedNodes.length + batch.removedNodes.length + batch.mutatedTextNodes.length;
      if (affectedCount === 0) return;

      if (affectedCount > 50) {
        clearSession();
        return;
      }

      pendingMutationBatch = batch;

      if (mutationDebounceTimer !== null) clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = setTimeout(() => {
        mutationDebounceTimer = null;
        if (pendingMutationBatch && sessionId) {
          rescanAffectedRegions(pendingMutationBatch);
          pendingMutationBatch = null;
        }
      }, 500);
    });
  }

  function stopMutationObserver(): void {
    mutationObserver?.disconnect();
    mutationObserver = null;
    if (mutationDebounceTimer !== null) {
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = null;
    }
  }

  startMutationObserver();
}

interface ScanSettings {
  enabledCategories: FindingCategory[];
  maxVisibleChars: number;
  maxNodeChars: number;
  maskPlaceholders: boolean;
  sessionTimeoutMs: number;
}