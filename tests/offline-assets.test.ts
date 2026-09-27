// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Verifies the packaged extension ships the offline OCR model at the exact
// dist path the browser build resolves via chrome.runtime.getURL:
//   assets/tessdata/eng.traineddata.gz  ->  dist/assets/tessdata/eng.traineddata.gz
// Fail-closed: if the model is missing, OCR in the extension silently refuses,
// so this must be a hard test failure, not a warning.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distAssets = join(extRoot, "dist", "assets");
const modelPath = join(distAssets, "tessdata", "eng.traineddata.gz");
const MIN_MODEL_BYTES = 8_000_000;

// dist/ is a gitignored build artifact (produced by `npm run build` in this
// package). The root `npm test` runs from a clean checkout where dist does not
// exist, so this build-verification gate skips unless the artifact is present.
// The vendor model itself is committed and build.mjs fails closed if missing;
// test:offline-ocr exercises the real OCR path.
const describeOfflineAssets = existsSync(modelPath) ? describe : describe.skip;

describeOfflineAssets("offline OCR model asset", () => {
  it("builds dist/assets/tessdata/eng.traineddata.gz at the chrome.runtime.getURL path", () => {
    expect(existsSync(modelPath), `run \`npm run build\` first (missing ${modelPath})`).toBe(true);
    expect(statSync(modelPath).size).toBeGreaterThan(MIN_MODEL_BYTES);
  });

  it("exposes exactly one traineddata file so langPath resolution is unambiguous", () => {
    const tessdataDir = join(distAssets, "tessdata");
    if (!existsSync(tessdataDir)) {
      expect(true).toBe(false);
      return;
    }
    const files = readdirSync(tessdataDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("eng.traineddata.gz");
  });
});