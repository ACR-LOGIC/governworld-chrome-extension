// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Guards the popup/sidepanel DOM contract. The 4-destination IA rewrite silently
// dropped elements that popup.ts still queried, leaving wired handlers attached to
// nothing — the build passed, the unit tests passed, and the features were simply
// unreachable. These assertions fail on that class of regression.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(extRoot, p), "utf8");

const POPUP = read("src/popup/index.html");
const SIDE = read("src/sidepanel/sidepanel.html");
const TS = read("src/popup/popup.ts");
const CSS = read("src/popup/popup.css");
const SIDE_CSS = read("src/sidepanel/sidepanel.css");

/** IDs popup.ts reaches for that do not exist in the given markup. */
function referencedIds(markup: string): string[] {
  const present = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const wanted = new Set<string>();
  for (const m of TS.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) wanted.add(m[1]);
  for (const m of TS.matchAll(/\$\(\s*["'`]#([A-Za-z0-9_-]+)["'`]\s*\)/g)) wanted.add(m[1]);
  for (const m of TS.matchAll(/querySelector[All]*<[^>]*>\(\s*["'`]#([A-Za-z0-9_-]+)/g)) wanted.add(m[1]);
  return [...wanted].filter((id) => !present.has(id)).sort();
}

describe("popup / sidepanel DOM contract", () => {
  it.each([
    ["src/popup/index.html", POPUP],
    ["src/sidepanel/sidepanel.html", SIDE],
  ])("%s provides every element popup.ts queries", (_name, markup) => {
    // #sr-announcements is created on demand by popup.ts, so it is legitimately absent.
    const missing = referencedIds(markup).filter((id) => id !== "sr-announcements");
    expect(missing, "popup.ts queries these IDs but the markup does not define them").toEqual([]);
  });

  it.each([
    ["src/popup/index.html", POPUP],
    ["src/sidepanel/sidepanel.html", SIDE],
  ])("%s contains no duplicate element ids", (_name, markup) => {
    const ids = [...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort();
    expect(dupes, "duplicate IDs make getElementById and label/for ambiguous").toEqual([]);
  });

  it("styles every layout class the popup markup uses", () => {
    const used = new Set<string>();
    for (const m of POPUP.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c) used.add(c);
    // Classes popup.ts creates at runtime are styled but never appear in the markup.
    for (const c of ["finding", "finding__check", "finding__severity", "doc-thumb-wrapper", "doc-thumb-overlay", "doc-thumb-canvas"]) {
      used.add(c);
    }
    const unstyled = [...used]
      .filter((c) => !new RegExp(`[.#]${c.replace(/[-]/g, "\\-")}(?![A-Za-z0-9_-])`).test(CSS))
      .sort();
    expect(unstyled, "these classes are used but have no CSS rule").toEqual([]);
  });

  it("keeps sidepanel.css in sync with popup.css", () => {
    expect(SIDE_CSS).toBe(CSS);
  });

  it("keeps the [hidden] attribute authoritative over class display rules", () => {
    // A class-level `display` beats the UA `[hidden] { display: none }`, which would
    // leave collapsed panels (results, document studio, progress) permanently visible.
    expect(CSS).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });
});
