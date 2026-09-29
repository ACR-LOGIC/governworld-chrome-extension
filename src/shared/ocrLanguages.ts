// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// The OCR languages whose traineddata is actually bundled in the package.
//
// This lives apart from src/document-pipeline/ocr.ts on purpose: that module
// imports tesseract.js, and the popup needs this list to build its language
// <select>. Importing it from there would pull the whole OCR engine into
// popup.js. Keeping the data here means the popup, the engine, and the build can
// all read it without dragging in tesseract.

export interface BundledOcrLanguage {
  /** ISO 639-3 code, as tesseract.js expects. */
  code: string;
  label: string;
  /** File name in vendor/tessdata/. */
  file: string;
}

/**
 * Single source of truth for offline OCR languages.
 *
 * The selector, `getWorker`, and the build's copy list all derive from this, and
 * tests/ocr-bundled-languages.test.ts asserts they agree. They previously did
 * not: the markup offered six languages while the build vendored only English,
 * so choosing Japanese ran English OCR with no indication anything was wrong.
 *
 * To add a language: drop the traineddata into vendor/tessdata/ and add an entry
 * here. The UI and the package follow automatically. Note the cost — each
 * traineddata file is roughly 10 MB compressed, so six languages adds about
 * 50 MB to the extension.
 */
export const BUNDLED_OCR_LANGUAGES: readonly BundledOcrLanguage[] = [
  { code: "eng", label: "English", file: "eng.traineddata.gz" },
] as const;

export const BUNDLED_OCR_CODES: readonly string[] = BUNDLED_OCR_LANGUAGES.map((l) => l.code);

export function isBundledOcrLanguage(code: string): boolean {
  return BUNDLED_OCR_CODES.includes(code);
}

export function traineddataFile(code: string): string | null {
  return BUNDLED_OCR_LANGUAGES.find((l) => l.code === code)?.file ?? null;
}
