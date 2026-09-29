// The three places that know which OCR languages are available must agree:
//   src/shared/ocrLanguages.ts   the declared list
//   build.mjs                    what gets copied into dist/assets/tessdata
//   the <select> in the popup    what the user is offered
//
// They previously did not. The markup listed English, Spanish, French, German,
// Japanese and Portuguese while the build vendored only the English traineddata,
// so selecting Japanese ran English OCR and said nothing. `getWorker` then fell
// back to English, hiding the mismatch entirely.
//
// This asserts the declared set, the vendored files and the markup agree, so a
// language can never be advertised without its data in the package.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_OCR_LANGUAGES, BUNDLED_OCR_CODES, traineddataFile } from "../src/shared/ocrLanguages.js";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(extRoot, rel), "utf8");

describe("bundled OCR languages", () => {
  it("declares at least one language", () => {
    expect(BUNDLED_OCR_LANGUAGES.length).toBeGreaterThan(0);
  });

  it("has a traineddata file vendored for every declared language", () => {
    for (const lang of BUNDLED_OCR_LANGUAGES) {
      expect(lang.file, `no file name for ${lang.code}`).toBeTruthy();
      expect(lang.file).toBe(`${lang.code}.traineddata.gz`);
      expect(existsSync(join(extRoot, "vendor", "tessdata", lang.file)), `vendor/tessdata/${lang.file} is missing`).toBe(
        true,
      );
    }
  });

  it("vendors no traineddata that is not declared", () => {
    const vendored = readdirSync(join(extRoot, "vendor", "tessdata")).filter((f) => f.endsWith(".traineddata.gz"));
    const declared = BUNDLED_OCR_LANGUAGES.map((l) => l.file).sort();
    expect(vendored.sort()).toEqual(declared);
  });

  it("the build copies exactly the declared set", () => {
    const build = read("build.mjs");
    // The build must read the list rather than hard-code languages, otherwise
    // adding a language to the declaration would not package it.
    expect(build).toContain("src/shared/ocrLanguages.ts");
    expect(build).toContain("copyFileSync(src, join(tessdataDir, file))");
    // And it must fail closed rather than shipping a language without its data.
    expect(build).toMatch(/Missing vendored OCR language data/);
  });

  it("the popup offers only declared languages", () => {
    // Scope to the OCR selects. A bare <option value="spa"> sweep also matches
    // the compliance-preset and category selects, which are unrelated.
    for (const file of ["src/popup/index.html", "src/sidepanel/sidepanel.html"]) {
      const html = read(file);
      for (const select of html.match(/<select[^>]*id="(?:doc-)?ocr-language-select"[\s\S]*?<\/select>/g) ?? []) {
        const options = [...select.matchAll(/<option value="([a-z]{3})"/g)].map((m) => m[1]);
        const undeclared = options.filter((code) => !BUNDLED_OCR_CODES.includes(code));
        expect(undeclared, `${file} offers undeclared OCR languages: ${undeclared.join(", ")}`).toEqual([]);
      }
    }
  });

  it("the popup builds its options from the declared list", () => {
    const popupTs = read("src/popup/popup.ts");
    expect(popupTs).toContain('from "../shared/ocrLanguages.js"');
    expect(popupTs).toContain("BUNDLED_OCR_LANGUAGES.map");
  });

  it("resolves traineddata names consistently", () => {
    for (const lang of BUNDLED_OCR_LANGUAGES) {
      expect(traineddataFile(lang.code)).toBe(lang.file);
    }
    expect(traineddataFile("zzz")).toBeNull();
  });

  it("does not import the OCR engine from the popup", () => {
    // BUNDLED_OCR_LANGUAGES lives in shared/ precisely so the popup can read it
    // without pulling tesseract.js into popup.js.
    const popupTs = read("src/popup/popup.ts");
    expect(popupTs).not.toMatch(/from "\.\.\/document-pipeline\/ocr\.js"/);
  });
});
