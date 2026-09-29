// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { createWorker, type Worker } from "tesseract.js";
import { assembleOcrText } from "./offsets.js";

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

/**
 * OCR languages whose traineddata is actually bundled in the package.
 *
 * Re-exported from shared/ocrLanguages so the popup can build its language
 * selector from the same list without importing tesseract.js.
 */
export { BUNDLED_OCR_LANGUAGES, BUNDLED_OCR_CODES, isBundledOcrLanguage, traineddataFile } from "../shared/ocrLanguages.js";
import { BUNDLED_OCR_CODES, traineddataFile } from "../shared/ocrLanguages.js";

export type OcrLanguage = string;

/** Languages the package can actually recognise offline. */
export const SUPPORTED_OCR_LANGUAGES: readonly string[] = BUNDLED_OCR_CODES;

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
    const file = traineddataFile(lang);
    if (!file) return false;
    const res = await fetch(assetUrl(`tessdata/${file}`));
    return res.ok;
  } catch {
    return false;
  }
}

export async function getWorker(requestedLang = "eng"): Promise<Worker> {
  // Only a bundled language is accepted. Falling back silently to English when
  // an unbundled one is requested is what made the language selector a lie, so
  // an unbundled request now fails closed with a message that says why.
  if (!BUNDLED_OCR_CODES.includes(requestedLang)) {
    throw new Error(
      `OCR language "${requestedLang}" is not bundled in this build. ` +
        `Available offline: ${BUNDLED_OCR_CODES.join(", ")}.`
    );
  }
  let activeLang = requestedLang;

  const targetPresent = await langDataPresent(activeLang);
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
  // tesseract.js 7 restructured the result tree to
  // page -> blocks -> paragraphs -> lines -> words, and `blocks` is NOT part of
  // the default output. Without this request `data.blocks` is null and
  // recognition returns zero tokens while still reporting success — the
  // document pipeline would quietly redact nothing.
  const result = await worker.recognize(source, undefined, { blocks: true, text: true });
  const data = result.data;
  const tokens: OcrToken[] = [];
  // A flat line index across the whole page keeps the token stream comparable
  // with the pre-v7 shape, where every line of the page was in one list.
  let lineIndex = 0;
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const w of line.words ?? []) {
          tokens.push({
            text: w.text,
            confidence: w.confidence,
            lineIndex,
            bbox: {
              x: w.bbox.x0,
              y: w.bbox.y0,
              width: w.bbox.x1 - w.bbox.x0,
              height: w.bbox.y1 - w.bbox.y0,
            },
          });
        }
        lineIndex += 1;
      }
    }
  }
  const fullText = assembleOcrText(tokens);
  return {
    pageIndex,
    widthPx: canvas.width,
    heightPx: canvas.height,
    tokens,
    // Must be the token-derived text, not Tesseract's own `data.text`: detection
    // runs over this string and core.ts maps the resulting offsets back to page
    // rectangles with the same function. Tesseract's text uses different
    // spacing, so returning it here silently misplaces every redaction box.
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