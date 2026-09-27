// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { MAX_DOC_PAGES } from "./contract.js";

/**
 * Batch redaction queue (roadmap §6 — shipped as the engine core).
 *
 * The roadmap design (docs/extension-improvement-roadmap.md §6) calls for
 * "sequential jobs through the singleton offscreen document; states
 * pending/processing/complete/failed/canceled; explicit cancel/retry/clear
 * failure UI; file-size and page-count limits enforced before work starts; no
 * raw persistence; ZIP assembled only after explicit user action and only from
 * successful outputs".
 *
 * This file implements that contract as a PURE, unit-testable engine:
 *   - exactly one in-flight job at a time (sequential through the singleton
 *     offscreen document), auto-advancing to the next pending job,
 *   - pre-enqueue limits (bytes + pages) enforced before any work starts,
 *   - cancel (pending → canceled; processing is aborted via AbortSignal),
 *   - retry (failed/canceled → pending),
 *   - clearFinished / dismissFailed-style cleanup,
 *   - `collectSuccessful` returns ONLY `complete` outputs, in enqueue order,
 *     so a ZIP is only ever assembled by the caller from successful outputs
 *     after an explicit user action.
 *
 * The engine holds metadata and in-memory output refs only. Document bytes are
 * provided by the injected processor and are never persisted by the engine.
 *
 * The offscreen-document transport + popup/sidepanel UI wiring are a thin
 * follow-on that drives this engine (see service-worker/index.ts); the engine
 * itself is transport-agnostic and deterministic.
 */

export type BatchJobStatus = "pending" | "processing" | "complete" | "failed" | "canceled";

export interface BatchJobInput {
  /** Caller-owned file handle key (IndexedDB docfiles key) for traceability. */
  fileKey: string;
  name: string;
  mimeType: string;
  kind: "pdf" | "image" | "docx";
  byteLength: number;
  /** Known page count when available; enforced when provided. */
  pageCount?: number;
}

export interface BatchJob {
  id: string;
  input: BatchJobInput;
  status: BatchJobStatus;
  /** Populated on failure. */
  error?: string;
  /** Output produced by the processor (in-memory, not persisted). */
  output?: { bytes: ArrayBuffer; mimeType: string };
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** True when a cancellation was requested while the job was processing. */
  cancelRequested?: boolean;
}

export interface BatchProcessor {
  /**
   * Redact one document and return the flattened output. MUST throw (or return
   * a rejected promise) when the signal aborts so the engine can mark the job
   * canceled rather than failed.
   */
  process(job: BatchJob, signal: AbortSignal): Promise<{ bytes: ArrayBuffer; mimeType: string }>;
}

export type BatchEnqueueResult =
  | { ok: true; job: BatchJob }
  | { ok: false; reason: "too_large" | "too_many_pages" | "duplicate_key"; message: string };

export interface BatchQueueOptions {
  /** Per-file size cap in bytes. Default 20 MiB (mirrors MAX_DOC_BYTES). */
  maxBytes?: number;
  /** Per-file page cap. Default MAX_DOC_PAGES (20). */
  maxPages?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Called after any job state change (UI projection). */
  onStateChange?: (job: BatchJob, queue: BatchJob[]) => void;
}

/** Default per-file size cap in bytes (mirrors the single-doc session limit). */
export const BATCH_MAX_BYTES = 20 * 1024 * 1024;

/** New job id. `crypto.randomUUID()` is available in MV3 service workers and
 *  Node 18+; a counter fallback keeps the engine testable everywhere. */
function newJobId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  let id = "";
  for (let i = 0; i < 4; i++) id += Math.floor(Math.random() * 0xffffffff).toString(36);
  return `job-${id}-${Date.now().toString(36)}`;
}

/**
 * Sequential document batch queue. Thread-safety is intentionally simple: the
 * extension service worker is single-threaded; the engine serializes the
 * processor through a single in-flight slot.
 */
export class DocumentBatchQueue {
  private readonly jobs: BatchJob[] = [];
  private readonly maxBytes: number;
  private readonly maxPages: number;
  private readonly now: () => number;
  private readonly onStateChange?: (job: BatchJob, queue: BatchJob[]) => void;
  private active: { job: BatchJob; controller: AbortController } | null = null;
  private started = false;

  public constructor(private readonly processor: BatchProcessor, options: BatchQueueOptions = {}) {
    this.processor = processor;
    this.maxBytes = options.maxBytes ?? BATCH_MAX_BYTES;
    this.maxPages = options.maxPages ?? MAX_DOC_PAGES;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  /**
   * Enqueue a document for sequential processing. Limits are enforced HERE,
   * before any work starts; an oversized or over-long file is refused with a
   * typed reason rather than enqueued.
   */
  public enqueue(input: BatchJobInput): BatchEnqueueResult {
    if (this.jobs.some((j) => j.input.fileKey === input.fileKey)) {
      return { ok: false, reason: "duplicate_key", message: "This file is already in the batch queue." };
    }
    if (input.byteLength > this.maxBytes) {
      return { ok: false, reason: "too_large", message: `File exceeds the ${Math.floor(this.maxBytes / (1024 * 1024))} MB size limit.` };
    }
    if (input.pageCount !== undefined && input.pageCount > this.maxPages) {
      return { ok: false, reason: "too_many_pages", message: `Document exceeds the ${this.maxPages} page limit.` };
    }
    const job: BatchJob = { id: newJobId(), input, status: "pending", enqueuedAt: this.now() };
    this.jobs.push(job);
    this.emit(job);
    if (this.started) void this.pump();
    return { ok: true, job };
  }

  /** Begin processing. No-op when already started or when the queue is empty. */
  public start(): void {
    this.started = true;
    void this.pump();
  }

  /** Cancel a job: pending → canceled; processing is aborted (best effort). */
  public cancel(id: string): boolean {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    if (job.status === "pending") {
      job.status = "canceled";
      job.finishedAt = this.now();
      this.emit(job);
      void this.pump();
      return true;
    }
    if (job.status === "processing" && this.active?.job.id === id) {
      job.cancelRequested = true;
      this.active.controller.abort();
      return true;
    }
    return false;
  }

  /** Retry a failed or canceled job: back to pending (front of its prior order). */
  public retry(id: string): boolean {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    if (job.status !== "failed" && job.status !== "canceled") return false;
    job.status = "pending";
    job.error = undefined;
    job.cancelRequested = false;
    delete job.finishedAt;
    delete job.output;
    this.emit(job);
    void this.pump();
    return true;
  }

  /** Drop terminal jobs (complete / failed / canceled). Failed jobs are kept
   *  until explicitly dismissed so users can read the error or retry. */
  public clearFinished(): void {
    const before = this.jobs.length;
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const s = this.jobs[i].status;
      if (s === "complete" || s === "failed" || s === "canceled") this.jobs.splice(i, 1);
    }
    if (this.jobs.length !== before && this.onStateChange) {
      // Synthetic emit so the UI can re-project the (possibly empty) list.
      const snapshot = [...this.jobs];
      for (const job of snapshot) this.onStateChange(job, snapshot);
    }
  }

  /** Ordered snapshot (enqueue order). */
  public snapshot(): BatchJob[] {
    return this.jobs.map((j) => ({ ...j, output: j.output ? { bytes: j.output.bytes, mimeType: j.output.mimeType } : undefined }));
  }

  /**
   * Successful outputs ONLY, in enqueue order. Callers assemble a ZIP only
   * from this list and only after an explicit user action (roadmap §6).
   */
  public collectSuccessful(): { name: string; mimeType: string; bytes: ArrayBuffer }[] {
    return this.jobs
      .filter((j) => j.status === "complete" && j.output)
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      .map((j) => ({ name: j.input.name, mimeType: j.output!.mimeType, bytes: j.output!.bytes }));
  }

  private async pump(): Promise<void> {
    if (!this.started || this.active) return;
    const next = this.jobs.find((j) => j.status === "pending");
    if (!next) return;

    next.status = "processing";
    next.startedAt = this.now();
    const controller = new AbortController();
    this.active = { job: next, controller };
    this.emit(next);

    try {
      const output = await this.processor.process(next, controller.signal);
      if (controller.signal.aborted) {
        this.settleCanceled(next);
      } else {
        next.output = output;
        next.status = "complete";
        next.finishedAt = this.now();
        this.emit(next);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        this.settleCanceled(next);
      } else {
        next.status = "failed";
        next.error = err instanceof Error ? err.message : String(err);
        next.finishedAt = this.now();
        this.emit(next);
      }
    } finally {
      this.active = null;
      // Sequential: advance to the next pending job.
      void this.pump();
    }
  }

  private settleCanceled(job: BatchJob): void {
    job.status = "canceled";
    job.finishedAt = this.now();
    this.emit(job);
  }

  private emit(job: BatchJob): void {
    this.onStateChange?.(job, this.snapshot());
  }
}
