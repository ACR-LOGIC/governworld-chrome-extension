// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { DocumentBatchQueue, type BatchJobInput, type BatchProcessor, type BatchJob } from "../src/document-pipeline/queue.js";
import { MAX_DOC_PAGES } from "../src/document-pipeline/contract.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const input = (over: Partial<BatchJobInput> = {}): BatchJobInput => ({
  fileKey: `key-${Math.random().toString(36).slice(2)}`,
  name: "doc.pdf",
  mimeType: "application/pdf",
  kind: "pdf",
  byteLength: 1024,
  ...over
});

interface PendingRun {
  resolve: (out: { bytes: ArrayBuffer; mimeType: string }) => void;
  reject: (e: Error) => void;
}

function deferredProcessor(order: string[]) {
  const runs: PendingRun[] = [];
  const processor: BatchProcessor = {
    process(job) {
      order.push(`start:${job.input.name}`);
      return new Promise((resolve, reject) => {
        runs.push({ resolve, reject });
      });
    }
  };
  const finishLatest = () => runs[runs.length - 1].resolve({ bytes: new ArrayBuffer(4), mimeType: "application/pdf" });
  const failLatest = (e: Error) => runs[runs.length - 1].reject(e);
  return { processor, finishLatest, failLatest, runs };
}

describe("DocumentBatchQueue", () => {
  it("refuses oversized files, over-page documents, and duplicate keys BEFORE any work starts", async () => {
    const order: string[] = [];
    const { processor, finishLatest } = deferredProcessor(order);
    const q = new DocumentBatchQueue(processor, { maxBytes: 100, maxPages: 5 });

    expect(q.enqueue(input({ byteLength: 101 }))).toMatchObject({ ok: false, reason: "too_large" });
    expect(q.enqueue(input({ byteLength: 50, pageCount: MAX_DOC_PAGES + 1 }))).toMatchObject({ ok: false, reason: "too_many_pages" });

    q.start();
    const ok = q.enqueue(input({ name: "a.pdf", byteLength: 50 }));
    expect(ok).toMatchObject({ ok: true });
    const second = q.enqueue((ok as { ok: true; job: BatchJob }).job.input);
    expect(second).toMatchObject({ ok: false, reason: "duplicate_key" });
    await flush();
    expect(order).toEqual(["start:a.pdf"]);
    finishLatest();
    await flush();
  });

  it("processes sequentially: the next job starts only after the current completes", async () => {
    const order: string[] = [];
    const { processor, finishLatest } = deferredProcessor(order);
    const q = new DocumentBatchQueue(processor, { now: () => order.length });
    q.start();
    q.enqueue(input({ name: "a.pdf" }));
    q.enqueue(input({ name: "b.pdf" }));
    q.enqueue(input({ name: "c.pdf" }));
    await flush();

    expect(order).toEqual(["start:a.pdf"]);
    finishLatest();
    await flush();
    expect(order).toEqual(["start:a.pdf", "start:b.pdf"]);
    finishLatest();
    await flush();
    expect(order).toEqual(["start:a.pdf", "start:b.pdf", "start:c.pdf"]);
    finishLatest();
    await flush();

    const states = q.snapshot().map((j) => `${j.input.name}:${j.status}`);
    expect(states).toEqual(["a.pdf:complete", "b.pdf:complete", "c.pdf:complete"]);
  });

  it("marks a failing job failed and continues with the next pending job", async () => {
    const order: string[] = [];
    const { processor, failLatest } = deferredProcessor(order);
    const q = new DocumentBatchQueue(processor, { now: () => order.length });
    q.start();
    q.enqueue(input({ name: "a.pdf" }));
    q.enqueue(input({ name: "b.pdf" }));
    await flush();
    failLatest(new Error("boom"));
    await flush();
    expect(order).toEqual(["start:a.pdf", "start:b.pdf"]);
    const a = q.snapshot().find((j) => j.input.name === "a.pdf")!;
    expect(a.status).toBe("failed");
    expect(a.error).toBe("boom");
  });

  it("cancel a pending job (never started) and lets the queue continue", async () => {
    const order: string[] = [];
    const { processor, finishLatest } = deferredProcessor(order);
    const q = new DocumentBatchQueue(processor, { now: () => order.length });
    q.start();
    q.enqueue(input({ name: "a.pdf" }));
    const b = q.enqueue(input({ name: "b.pdf" })) as { ok: true; job: BatchJob };
    q.cancel(b.job.id);
    await flush();
    expect(q.snapshot().find((j) => j.input.name === "b.pdf")!.status).toBe("canceled");
    finishLatest();
    await flush();
    expect(order).toEqual(["start:a.pdf"]);
  });

  it("cancel an in-flight job aborts the processor and settles it canceled, not failed", async () => {
    const order: string[] = [];
    const processor: BatchProcessor = {
      process(_job, signal) {
        order.push("start");
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
    };
    const q = new DocumentBatchQueue(processor, { now: () => order.length });
    q.start();
    const job = q.enqueue(input({ name: "a.pdf" })) as { ok: true; job: BatchJob };
    await flush();
    q.cancel(job.job.id);
    await flush();
    const s = q.snapshot()[0];
    expect(s.status).toBe("canceled");
    expect(s.error).toBeUndefined();
  });

  it("retry moves a failed job back to pending and re-processes it", async () => {
    const order: string[] = [];
    const { processor, finishLatest } = deferredProcessor(order);
    let failNext = true;
    const wrapping: BatchProcessor = {
      process(job, signal) {
        order.push(`attempt:${job.input.name}`);
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("transient"));
        }
        return processor.process(job, signal);
      }
    };
    const q = new DocumentBatchQueue(wrapping, { now: () => order.length });
    q.start();
    const e = q.enqueue(input({ name: "a.pdf" })) as { ok: true; job: BatchJob };
    await flush();
    expect(q.snapshot()[0].status).toBe("failed");
    expect(order.filter((o) => o === "attempt:a.pdf").length).toBe(1);
    q.retry(e.job.id);
    await flush();
    expect(q.snapshot()[0].status).toBe("processing");
    finishLatest();
    await flush();
    expect(q.snapshot()[0].status).toBe("complete");
    expect(order.filter((o) => o === "attempt:a.pdf").length).toBe(2);
  });

  it("collectSuccessful returns ONLY complete outputs in enqueue order", async () => {
    const order: string[] = [];
    const { processor, finishLatest } = deferredProcessor(order);
    const q = new DocumentBatchQueue(processor, { now: () => order.length });
    q.start();
    q.enqueue(input({ name: "a.pdf" }));
    const b = q.enqueue(input({ name: "b.pdf" })) as { ok: true; job: BatchJob };
    q.enqueue(input({ name: "c.pdf" }));
    await flush();
    q.cancel(b.job.id);
    finishLatest(); // a completes
    await flush();
    finishLatest(); // c completes
    await flush();

    const out = q.collectSuccessful();
    expect(out.map((o) => o.name)).toEqual(["a.pdf", "c.pdf"]);
  });

  it("clearFinished drops terminal jobs and keeps pending/processing", async () => {
    const order: string[] = [];
    const { processor, finishLatest } = deferredProcessor(order);
    const q = new DocumentBatchQueue(processor, { now: () => order.length });
    q.start();
    q.enqueue(input({ name: "a.pdf" }));
    q.enqueue(input({ name: "b.pdf" }));
    await flush();
    finishLatest(); // a completes
    await flush();
    q.clearFinished();
    const names = q.snapshot().map((j) => j.input.name);
    expect(names).toEqual(["b.pdf"]);
  });

  it("fires onStateChange after each transition", async () => {
    const events: string[] = [];
    const { processor, finishLatest } = deferredProcessor([]);
    const q = new DocumentBatchQueue(processor, {
      now: () => events.length,
      onStateChange: (job) => events.push(`${job.input.name}:${job.status}`)
    });
    q.start();
    q.enqueue(input({ name: "a.pdf" }));
    await flush();
    finishLatest();
    await flush();
    expect(events).toContain("a.pdf:pending");
    expect(events).toContain("a.pdf:processing");
    expect(events).toContain("a.pdf:complete");
  });
});
