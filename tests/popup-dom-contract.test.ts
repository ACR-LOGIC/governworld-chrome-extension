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

/**
 * Class names popup.ts applies to nodes it builds at runtime. These never appear in
 * the markup, so a markup-only scan would flag them as unstyled. Derived from the
 * four ways the controller assigns classes rather than a maintained list, so a new
 * `el("li", "some-class")` is covered without editing the test.
 */
function runtimeClasses(): Set<string> {
  const out = new Set<string>();
  const add = (raw: string) => {
    for (const c of raw.split(/\s+/)) if (c) out.add(c);
  };
  // el("li", "finding"), el("div", "btn btn--ghost", "…") — 2nd argument only.
  for (const m of TS.matchAll(/\bel\(\s*[`"][a-z0-9-]+[`"]\s*,\s*[`"]([^`"]+)[`"]/gi)) add(m[1]);
  // node.className = "…"
  for (const m of TS.matchAll(/\.className\s*=\s*[`"]([^`"]+)[`"]/g)) add(m[1]);
  // classList.add/toggle("…") — state classes layered on top of a base class.
  for (const m of TS.matchAll(/classList\.(?:add|remove|toggle)\(\s*[`"]([^`"]+)[`"]/g)) add(m[1]);
  // setAttribute("class", "…")
  for (const m of TS.matchAll(/setAttribute\(\s*[`"]class[`"]\s*,\s*[`"]([^`"]+)[`"]/g)) add(m[1]);
  return out;
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
    for (const c of runtimeClasses()) used.add(c);
    const unstyled = [...used]
      .filter((c) => !new RegExp(`[.#]${c.replace(/[-]/g, "\\-")}(?![A-Za-z0-9_-])`).test(CSS))
      .sort();
    expect(unstyled, "these classes are used but have no CSS rule").toEqual([]);
  });

  it("discovers runtime-created classes rather than hardcoding them", () => {
    // Guards the discovery helper itself: if a new construction site appears that the
    // regexes miss, this fails loudly instead of silently under-reporting coverage.
    const found = runtimeClasses();
    for (const expected of [
      "finding",
      "finding__check",
      "finding__severity",
      "finding__badge-attr",
      "finding--report-only",
      "doc-thumb-wrapper",
      "doc-thumb-canvas",
      "status--error",
      "badge--cloud",
      "guide-card--highlight",
      "tool-btn--active",
      "tab-btn--active",
      "tab-panel--active",
      "settings-nav-btn--active",
      "settings-page--active",
      "shield-banner--inactive",
      "doc-dropzone--active",
    ]) {
      expect([...found], `runtimeClasses() should discover "${expected}"`).toContain(expected);
    }
  });

  it("keeps sidepanel.css in sync with popup.css", () => {
    expect(SIDE_CSS).toBe(CSS);
  });

  it("keeps the [hidden] attribute authoritative over class display rules", () => {
    // A class-level `display` beats the UA `[hidden] { display: none }`, which would
    // leave collapsed panels (results, document studio, progress) permanently visible.
    expect(CSS).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  it("has no dead class selectors in the stylesheet", () => {
    // A class selector can only match if every class it requires exists, so a rule
    // mentioning a dead class is unsatisfiable. The 4-destination IA rewrite left
    // ~40 such rules behind; this stops them accumulating again.
    //   node --experimental-strip-types scripts/prune-dead-css.mts --check
    const live = new Set<string>([...classNamesIn(POPUP), ...runtimeClasses()]);
    const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, " ");

    const dead = new Set<string>();
    for (const block of rulePreludes(stripped)) {
      for (const part of splitCommas(block)) {
        const classes = [...part.matchAll(/\.((?:[A-Za-z0-9_-]|\\.)+)/g)].map((m) =>
          m[1].replace(/\\(.)/g, "$1"),
        );
        if (classes.length && !classes.every((c) => live.has(c))) {
          for (const c of classes) if (!live.has(c)) dead.add(c);
        }
      }
    }
    expect([...dead].sort(), "run scripts/prune-dead-css.mts to remove these").toEqual([]);
  });
});

/** Class tokens from a `class="…"` attribute list. */
function classNamesIn(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c) out.push(c);
  return out;
}

/** Selector preludes of every top-level rule, ignoring @keyframes/@font-face bodies. */
function rulePreludes(css: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < css.length) {
    let brace = -1;
    for (let j = i; j < css.length; j++) {
      if (css[j] === "{") { brace = j; break; }
      if (css[j] === ";" && css.slice(i, j).trimStart().startsWith("@")) break;
    }
    if (brace < 0) break;
    const prelude = css.slice(i, brace);
    if (prelude.trim() && !/^\s*@(keyframes|font-face|property)/.test(prelude)) out.push(prelude);
    // Skip the matching body.
    let depth = 0;
    let k = brace;
    for (; k < css.length; k++) {
      if (css[k] === "{") depth++;
      else if (css[k] === "}") { depth--; if (!depth) break; }
    }
    i = k + 1;
  }
  return out;
}

function splitCommas(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of prelude) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
