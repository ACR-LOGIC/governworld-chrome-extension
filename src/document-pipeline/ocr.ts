// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { createWorker, type Worker } from "tesseract.js";

/**
 * Local OCR via Tesseract. Worker/core/lang assets are resolved to bundled
 * extension URLs (chrome.runtime.getURL) so recognition never depends on the
 * network in local mode. If the bundled language data is absent, recognition
 * fails closed with a clear message instead of reaching out to a CDN.
 */

export interface OcrToken {
  text: string;
  confidence: number;
  lineIndex: number;
  bbox: { x: number; y: number; width: number; height: number };
}

export interface OcrPageResult {
  pageIndex: number;
  widthPx: number;
  heightPx: number;
  tokens: OcrToken[];
  fullText: string;
}

export const SUPPORTED_OCR_LANGUAGES = ["eng", "spa", "fra", "deu", "jpn", "por"] as const;
export type OcrLanguage = (typeof SUPPORTED_OCR_LANGUAGES)[number];

let currentWorkerLang: string | null = null;
let workerPromise: Promise<Worker> | null = null;

// tesseract.js resolves `createWorker` only after worker core init + language
// load + API init. If any step rejects without posting a message (as happens
// when core wasm init fails under a restrictive CSP), the promise never
// settles. Bound it so OCR init failures DENY promptly instead of hanging to
// the job timeout, keeping the pipeline fail-closed.
const WORKER_INIT_TIMEOUT_MS = 30_000;

async function withInitTimeout(promise: Promise<Worker>): Promise<Worker> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("OCR engine failed to initialize in time; text recognition is unavailable in offline mode.")),
      WORKER_INIT_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assetUrl(name: string): string {
  return chrome.runtime.getURL(`assets/${name}`);
}

export async function langDataPresent(lang: string): Promise<boolean> {
  // Traineddata is vendored into dist/assets/tessdata at build time. If it is
  // absent, fail closed rather than download from a CDN.
  try {
    const res = await fetch(assetUrl(`tessdata/${lang}.traineddata.gz`));
    return res.ok;
  } catch {
    return false;
  }
}

export async function getWorker(requestedLang = "eng"): Promise<Worker> {
  const targetLang = (SUPPORTED_OCR_LANGUAGES as readonly string[]).includes(requestedLang) ? requestedLang : "eng";
  let activeLang = targetLang;

  const targetPresent = await langDataPresent(targetLang);
  if (!targetPresent) {
    const engPresent = await langDataPresent("eng");
    if (engPresent) {
      activeLang = "eng";
    } else {
      throw new Error("Language data is not installed; OCR is unavailable in offline mode.");
    }
  }

  if (workerPromise && currentWorkerLang !== activeLang) {
    await resetOcr();
  }

  if (!workerPromise) {
    currentWorkerLang = activeLang;
    workerPromise = withInitTimeout(
      createWorker(activeLang, 1, {
        workerPath: assetUrl("tesseract.worker.min.js"),
        workerBlobURL: false,
        corePath: assetUrl("tesseract-core.wasm.js"),
        langPath: assetUrl("tessdata"),
        logger: () => {}, // never log recognition output
      })
    );
    // Reset so a failed init can be retried.
    workerPromise.catch(() => {
      workerPromise = null;
      currentWorkerLang = null;
    });
  }
  return workerPromise;
}

export async function resetOcr(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise;
    await w.terminate().catch(() => undefined);
    workerPromise = null;
    currentWorkerLang = null;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not read canvas"))), "image/png");
  });
}

export async function ocrCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  pageIndex: number,
  lang = "eng"
): Promise<OcrPageResult> {
  const worker = await getWorker(lang);
  const source = canvas instanceof OffscreenCanvas ? await canvas.convertToBlob() : await canvasToBlob(canvas);
  const result = await worker.recognize(source);
  const data = result.data;
  const tokens: OcrToken[] = [];
  for (let lineIdx = 0; lineIdx < (data.lines?.length ?? 0); lineIdx++) {
    for (const w of data.lines[lineIdx].words) {
      tokens.push({
        text: w.text,
        confidence: w.confidence,
        lineIndex: lineIdx,
        bbox: {
          x: w.bbox.x0,
          y: w.bbox.y0,
          width: w.bbox.x1 - w.bbox.x0,
          height: w.bbox.y1 - w.bbox.y0,
        },
      });
    }
  }
  const fullText = tokens
    .map((t, i) => (i > 0 && t.lineIndex !== tokens[i - 1].lineIndex ? "\n" : i > 0 ? " " : "") + t.text)
    .join("");
  return {
    pageIndex,
    widthPx: canvas.width,
    heightPx: canvas.height,
    tokens,
    fullText,
  };
}

export async function ocrPages(
  canvases: (HTMLCanvasElement | OffscreenCanvas)[],
  lang = "eng"
): Promise<OcrPageResult[]> {
  const out: OcrPageResult[] = [];
  for (let i = 0; i < canvases.length; i++) {
    out.push(await ocrCanvas(canvases[i], i, lang));
  }
  return out;
}