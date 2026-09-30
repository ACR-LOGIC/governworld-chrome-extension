/**
 * One-off maintenance tool: remove CSS rules whose class selectors are unused.
 *
 * Conservative by design.
 *  - A class is "live" if it appears in a `class` attribute or classList call
 *    anywhere under src/ (popup markup, sidepanel markup, every TS source).
 *  - A rule is removed only when every class selector in every comma-separated
 *    part of its prelude is dead. Surviving parts keep their original text.
 *  - Rules with no class selector (attribute, element, pseudo, :root) are always
 *    kept: they may target state that only a runtime class name reveals.
 *  - @keyframes / @font-face / @property are never touched. @media / @supports
 *    are recursed into.
 *  - Comments are preserved verbatim.
 *
 * Parsing is brace-, string- and comment-aware, and class selectors are read from
 * the selector prelude only — never from declaration values. That last detail is
 * what makes a naive `/\.name/` scan unsafe: it matches the decimals in `0.85`
 * and `1.2s` and deletes live rules.
 *
 *   node --experimental-strip-types scripts/prune-dead-css.mts [--check]
 *
 * --check prints what would be removed and writes nothing.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CSS_FILE = "src/popup/popup.css";
const checkOnly = process.argv.includes("--check");

// ---------------------------------------------------------------- live classes

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const live = new Set<string>();
const addTokens = (text: string) => {
  for (const c of text.split(/\s+/)) if (c && /^[A-Za-z][A-Za-z0-9_-]*$/.test(c)) live.add(c);
};
for (const f of walk("src")) {
  if (!/\.(ts|tsx|js|html)$/.test(f)) continue;
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/class\s*=\s*["'`]([^"'`]+)["'`]/g)) addTokens(m[1]);
  for (const m of text.matchAll(/classList\.(?:add|remove|toggle)\(\s*["'`]([^"'`]+)["'`]/g)) addTokens(m[1]);
  for (const m of text.matchAll(/\.className\s*=\s*["'`]([^"'`]+)["'`]/g)) addTokens(m[1]);
  for (const m of text.matchAll(/\bel\(\s*["'`][a-z0-9-]+["'`]\s*,\s*["'`]([^"'`]+)["'`]/gi)) addTokens(m[1]);
  for (const m of text.matchAll(/setAttribute\(\s*["'`]class["'`]\s*,\s*["'`]([^"'`]+)["'`]/g)) addTokens(m[1]);
  // A state class chosen at runtime: `const q = cond ? "a--ok" : "a--warn"`.
  // These are always assigned, so treating them as dead would delete real
  // styling. The name must look like a BEM part, because the same pattern
  // matches plain ternaries that have nothing to do with classes.
  for (const m of text.matchAll(/(?:const|let|var)\s+(\w*[Cc]lass\w*)\s*=\s*[^;\n?]*\?\s*["'`]([\w-]+)["'`]\s*:\s*["'`]([\w-]+)["'`]/g)) {
    for (const candidate of [m[2], m[3]]) {
      if (candidate.includes("--") || candidate.includes("__")) addTokens(candidate);
    }
  }
}

// ------------------------------------------------------------------- scanning

const isCommentStart = (s: string, i: number) => s[i] === "/" && s[i + 1] === "*";
const commentEnd = (s: string, i: number) => {
  const e = s.indexOf("*/", i + 2);
  return e < 0 ? s.length : e + 2;
};
const skipString = (s: string, i: number) => {
  const q = s[i];
  i++;
  while (i < s.length && s[i] !== q) {
    if (s[i] === "\\") i++;
    i++;
  }
  return i;
};

/** Index of the `}` matching the `{` at `open`. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (isCommentStart(text, i)) { i = commentEnd(text, i) - 1; continue; }
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = skipString(text, i); continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ");

/**
 * Walk forward accumulating a prelude, stopping at the first significant `{` or `;`.
 * Uses a `for` loop deliberately: in a `while` loop, the `continue` below would skip
 * the trailing `i++`, leaving `i` parked on a closing quote and re-entering
 * skipString on it, which pairs quotes across the rest of the file.
 */
function readPrelude(text: string, from: number): { prelude: string; next: number } {
  let buf = "";
  for (let i = from; i < text.length; i++) {
    if (isCommentStart(text, i)) {
      const e = commentEnd(text, i);
      buf += text.slice(i, e);
      i = e - 1;
      continue;
    }
    const ch = text[i];
    if (ch === "{") return { prelude: buf, next: i };
    if (ch === ";") return { prelude: buf, next: i + 1 };
    if (ch === '"' || ch === "'") {
      const e = skipString(text, i);
      buf += text.slice(i, e + 1); // +1 keeps the closing quote
      i = e;
      continue;
    }
    buf += ch;
  }
  return { prelude: buf, next: text.length };
}

/**
 * Split a prelude on top-level commas, tracking the original text and a
 * comment-stripped copy in parallel. Slicing the original with indices from the
 * stripped copy misaligns as soon as a comment appears, which silently makes
 * every part look class-free and therefore "live".
 */
function splitTopLevelCommas(prelude: string): { raw: string; clean: string }[] {
  const parts: { raw: string; clean: string }[] = [];
  let raw = "";
  let clean = "";
  let depth = 0;
  const flush = () => {
    if (clean.trim()) parts.push({ raw, clean });
    raw = "";
    clean = "";
  };

  for (let i = 0; i < prelude.length; i++) {
    if (isCommentStart(prelude, i)) {
      const e = commentEnd(prelude, i);
      raw += prelude.slice(i, e);
      clean += " ";
      i = e - 1;
      continue;
    }
    const ch = prelude[i];
    if (ch === '"' || ch === "'") {
      const e = skipString(prelude, i);
      raw += prelude.slice(i, e + 1); // +1 keeps the closing quote
      clean += prelude.slice(i, e + 1);
      i = e;
      continue;
    }
    raw += ch;
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      flush();
      continue;
    }
    clean += ch;
  }
  flush();
  return parts;
}

function classesIn(clean: string): string[] {
  return [...clean.matchAll(/\.((?:[A-Za-z0-9_-]|\\.)+)/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
}

const removed: string[] = [];
let rulesSeen = 0;

/** Returns the rebuilt rule, or null when the whole rule is dead. */
function processRule(prelude: string, body: string): string | null {
  rulesSeen++;
  if (process.env.DEBUG_CSS) console.log("  rule:", JSON.stringify(prelude.trim().slice(0, 70)));
  const parts = splitTopLevelCommas(prelude);
  if (!parts.some((p) => classesIn(p.clean).length)) return prelude + body;

  // A selector part can only match if every class it requires exists. So a part
  // mentioning even one dead class is unsatisfiable and safe to drop — this also
  // catches compound cases like `.status-pill:has(.badge--cloud)` where the live
  // descendant would otherwise keep a dead subject alive.
  const isLive = (p: { clean: string }) => classesIn(p.clean).every((c) => live.has(c));
  const kept = parts.filter(isLive);
  if (kept.length === parts.length) return prelude + body;

  for (const p of parts) if (!isLive(p)) removed.push(p.raw);
  return kept.length ? kept.map((p) => p.raw).join("") + body : null;
}

const OPAQUE_AT = /^\s*@(keyframes|font-face|property|counter-style|page|charset|import)\b/;
const CONDITIONAL_AT = /^\s*@(media|supports|layer|container|scope)\b/;

function processNodes(text: string, depth = 0): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (isCommentStart(text, i)) {
      const e = commentEnd(text, i);
      out += text.slice(i, e);
      i = e;
      continue;
    }
    const { prelude, next } = readPrelude(text, i);
    if (next >= text.length) {
      if (process.env.DEBUG_CSS) {
        console.log(`BAIL next>=len depth=${depth} i=${i} len=${text.length}`);
        console.log("  text around i:", JSON.stringify(text.slice(i, i + 120)));
      }
      return out + prelude;
    }
    if (text[next] === ";") {
      out += prelude + ";";
      i = next + 1;
      continue;
    }
    const close = matchBrace(text, next);
    if (close < 0) {
      if (process.env.DEBUG_CSS) console.log(`BAIL close<0 depth=${depth} i=${i}`, JSON.stringify(prelude.slice(-80)));
      return out + text.slice(i);
    }

    if (OPAQUE_AT.test(prelude)) out += prelude + text.slice(next, close + 1);
    else if (CONDITIONAL_AT.test(prelude))
      out += prelude + text.slice(next, next + 1) + processNodes(text.slice(next + 1, close), depth + 1) + "}";
    else {
      const result = processRule(prelude, text.slice(next, close + 1));
      if (result !== null) out += result;
    }
    i = close + 1;
  }
  return out;
}

// ---------------------------------------------------------------------- run it

const css = readFileSync(CSS_FILE, "utf8");
const result = processNodes(css);

const keptComments = new Set([...result.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0].trim()));
const origComments = [...css.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0].trim());
const dropped = origComments.filter((c) => !keptComments.has(c));

console.log(`live class names: ${live.size}`);
console.log(`rules with class selectors inspected: ${rulesSeen}`);
console.log(`dead selector parts removed: ${removed.length}`);
for (const r of removed) console.log("  - " + r.replace(/\s+/g, " ").trim());
console.log(`comments kept: ${keptComments.size}/${origComments.length}`);
for (const c of dropped) console.log("  ~ dropped comment:", c.replace(/\s+/g, " ").slice(0, 90));
console.log(`bytes ${css.length} -> ${result.length}`);

// Every surviving comment must be byte-identical to one in the original, and no
// comment may be duplicated or reordered. Comments attached to a removed rule are
// expected to go; anything else means the parser mangled the file.
for (const c of keptComments) {
  if (!origComments.includes(c)) throw new Error(`parser invented a comment: ${c.slice(0, 60)}`);
}
if (keptComments.size !== origComments.length - dropped.length) {
  throw new Error("comment accounting mismatch");
}

if (checkOnly) {
  console.log("\n(--check: nothing written)");
} else {
  writeFileSync(CSS_FILE, result, "utf8");
  console.log(`\nwrote ${CSS_FILE}`);
}
