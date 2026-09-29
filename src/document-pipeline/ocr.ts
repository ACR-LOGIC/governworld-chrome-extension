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

/**
 * Worker options, assembled in one place so the contract is testable.
 *
 * tesseract.js ships defaults that point at a CDN: its default `workerPath` is
 * `https://cdn.jsdelivr.net/.../worker.min.js`, and inside the worker the
 * default `langPath` is `https://cdn.jsdelivr.net/npm/@tesseract.js-data/...`.
 * Every one of those is overridden here, so a correct build never touches the
 * network. That is an invariant worth a test rather than a comment, because
 * dropping any one of these three lines would silently reintroduce a remote
 * fetch of executable code and language data into the document pipeline - the
 * one pipeline that is supposed to have no network path at all.
 *
 * `tests/ocr-offline-assets.test.ts` asserts all three are local asset URLs and
 * that no value is an absolute URL.
 */
export function buildOcrWorkerOptions(): {
  workerPath: string;
  workerBlobURL: boolean;
  corePath: string;
  langPath: string;
  // tesseract calls the logger with a progress object, and depending on version
  // that object can carry recognised text. The signature is deliberately
  // variadic so the intent is explicit: arguments are accepted and discarded,
  // never logged.
  logger: (...args: unknown[]) => void;
} {
  return {
    workerPath: assetUrl("tesseract.worker.min.js"),
    workerBlobURL: false,
    corePath: assetUrl("tesseract-core.wasm.js"),
    langPath: assetUrl("tessdata"),
    logger: () => {}, // never log recognition output
  };
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

  // Fail closed if the data for the requested language is missing, rather than
  // substituting English. The previous behaviour was to fall back to English
  // whenever English happened to be present, which is unreachable today only
  // because English is the single bundled language - the moment a second
  // language is vendored, a user selecting it would silently get English OCR
  // and a clean-looking result. For a tool people use to decide what is safe to
  // disclose, a wrong answer that reports success is worse than a visible
  // failure, so the same reasoning that rejects an unbundled language applies
  // to bundled-but-absent.
  const targetPresent = await langDataPresent(requestedLang);
  if (!targetPresent) {
    throw new Error(
      `OCR language data for "${requestedLang}" is missing from this build, so ` +
        `recognition was not run. This is a packaging fault, not a fallback ` +
        `situation: silently recognising the page in a different language would ` +
        `produce a result that looks complete and is not.`
    );
  }
  const activeLang = requestedLang;

  if (workerPromise && currentWorkerLang !== activeLang) {
    await resetOcr();
  }

  if (!workerPromise) {
    currentWorkerLang = activeLang;
    workerPromise = withInitTimeout(createWorker(activeLang, 1, buildOcrWorkerOptions()));
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