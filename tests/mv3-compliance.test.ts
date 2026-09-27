// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// MV3 static compliance gates for extension source. These are the rules that
// silently break at runtime rather than at build time, so they are asserted
// against the source tree instead of trusted to review:
//
//   1. The declared MV3 CSP is `script-src 'self' 'wasm-unsafe-eval'`, which
//      blocks inline script and inline event handlers on every extension page.
//      An inline <script> in popup/sidepanel/offscreen/landing/privacy renders
//      as dead markup with no build error, so it is asserted out.
//   2. The codebase standard is async/await; `.then()` chains reintroduce
//      unhandled-rejection and error-swallowing shapes the rest of the code
//      avoids, so they are asserted out of src/ and tests/.
//   3. `eval` / `new Function` are outright banned by the CSP and rejected at
//      load time.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** HTML pages that ship inside the extension package (see build.mjs copy list). */
const EXTENSION_PAGES = [
  "src/popup/index.html",
  "src/popup/privacy.html",
  "src/sidepanel/sidepanel.html",
  "src/offscreen/offscreen.html",
  "src/landing/index.html",
];

/** Recursively collect files with the given extensions. */
function collectFiles(dir: string, extensions: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full, extensions));
    } else if (extensions.has(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Remove comments and string/template literals before matching, so this gate's
 * own rule text, failure messages, and assertion fixtures cannot match the
 * patterns it enforces. Regex literals are left in place; their escaped bodies
 * cannot match the patterns either.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

describe("extension page content security policy", () => {
  it.each(EXTENSION_PAGES)("%s declares no inline script", (relativePath) => {
    const html = readFileSync(join(extRoot, relativePath), "utf8");
    const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter(([, attrs, body]) => !/\bsrc\s*=/i.test(attrs) && body.trim().length > 0)
      .map(([, attrs]) => attrs.trim());
    expect(
      inlineScripts,
      `${relativePath} has an inline <script>. MV3 'script-src \'self\'' blocks it at runtime; move the code to an external file.`
    ).toEqual([]);
  });

  it.each(EXTENSION_PAGES)("%s declares no inline event handlers", (relativePath) => {
    const html = readFileSync(join(extRoot, relativePath), "utf8");
    const handlers = [...html.matchAll(/\son[a-z]+\s*=\s*["']/gi)].map(([match]) => match.trim());
    expect(
      handlers,
      `${relativePath} has an inline event handler, which MV3 CSP forbids.`
    ).toEqual([]);
  });

  it.each(EXTENSION_PAGES)("%s contains no javascript: URL", (relativePath) => {
    const html = readFileSync(join(extRoot, relativePath), "utf8");
    expect(html, `${relativePath} has a javascript: URL.`).not.toMatch(/href\s*=\s*["']javascript:/i);
  });
});

describe("retired capabilities", () => {
  // Rule Pack import/export was removed as a product capability: export
  // serialized the full GovernWorld detection surface (categories, confidence
  // thresholds, mask padding) into a portable JSON file. Per-detector
  // confidence sliders were removed because the detection engine, not the user,
  // owns those thresholds. Both decisions are product boundaries, so they are
  // asserted here rather than left to review.
  const PAGES = ["src/popup/index.html", "src/sidepanel/sidepanel.html"];

  it.each(PAGES)("%s has no rule pack import/export controls", (relativePath) => {
    const html = readFileSync(join(extRoot, relativePath), "utf8");
    for (const id of ["import-pack-btn", "export-pack-btn", "rule-pack-file", "rule-pack-status"]) {
      expect(html, `${relativePath} still references #${id}`).not.toContain(id);
    }
  });

  it.each(PAGES)("%s has no per-detector confidence sliders", (relativePath) => {
    const html = readFileSync(join(extRoot, relativePath), "utf8");
    expect(html, `${relativePath} still renders a confidence threshold list`).not.toContain("threshold-list");
    expect(html, `${relativePath} must not ship an inline range input`).not.toMatch(/type="range"/);
  });

  it("the rule pack serializer is gone from the codebase", () => {
    const offenders = collectFiles(join(extRoot, "src"), new Set([".ts", ".js", ".html"]))
      .filter((file) => /serializeRulePack|parseRulePack|RulePack/.test(readFileSync(file, "utf8")))
      .map((file) => relative(extRoot, file));
    expect(offenders, "Rule Pack code still present").toEqual([]);
  });

  it("exposes no range input at runtime", async () => {
    const source = stripComments(readFileSync(join(extRoot, "src/popup/popup.ts"), "utf8"));
    expect(source).not.toContain(".type = \"range\"");
  });

  it("keeps category-level selection as the only per-rule lever", () => {
    const settings = readFileSync(join(extRoot, "src/shared/settings.ts"), "utf8");
    // Categories remain user-selectable; only per-detector thresholds were removed.
    expect(settings).toContain("ALL_CATEGORIES");
    expect(settings).toContain("confidenceThresholds");
  });
});

describe("dynamic code evaluation", () => {
  const codeFiles = [
    ...collectFiles(join(extRoot, "src"), new Set([".ts", ".js"])),
    ...collectFiles(join(extRoot, "tests"), new Set([".ts", ".js"])),
  ];

  it("finds source files to scan", () => {
    expect(codeFiles.length).toBeGreaterThan(10);
  });

  it.each(codeFiles)("%s never calls eval or new Function", (absolutePath) => {
    const source = stripComments(readFileSync(absolutePath, "utf8"));
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/\bnew\s+Function\s*\(/);
  });

  it.each(codeFiles)("%s uses async/await instead of promise chains", (absolutePath) => {
    const source = stripComments(readFileSync(absolutePath, "utf8"));
    const relativePath = relative(extRoot, absolutePath).replace(/\\/g, "/");
    const offendingLines = source
      .split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
      .filter(({ line }) => /\.then\s*\(/.test(line));
    expect(
      offendingLines,
      `${relativePath} chains promises. Use async/await so rejections stay on the awaited path.`
    ).toEqual([]);
  });
});
