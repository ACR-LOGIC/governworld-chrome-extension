// Diagnostic: what does the on-device detector match, and which pattern is
// responsible? Prints every match with its category and exact span, so an
// over-redaction can be attributed to a named pattern instead of inferred from
// a pixel diff.
//
//   node scripts/inspect-detect.mjs "Amount Due: $248.00"

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detect } from "../src/content/detect.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Category ids come from the FindingCategory union, which is the single source
// of truth for what can be detected.
const types = readFileSync(join(root, "src", "shared", "types.ts"), "utf8");
const union = types.match(/export type FindingCategory =([\s\S]*?);/);
if (!union) throw new Error("could not read the FindingCategory union from src/shared/types.ts");
const categories = [...union[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

const samples = process.argv.length > 2 ? process.argv.slice(2) : ["Amount Due: $248.00"];

for (const text of samples) {
  const matches = detect(text, categories, []);
  console.log(`text:    ${JSON.stringify(text)}`);
  console.log(`matches: ${matches.length}`);
  for (const m of matches) {
    console.log(
      `  ${m.category.padEnd(20)} conf=${(m.confidence * 100).toFixed(0)}%  span=${m.start}..${m.end}  value=${JSON.stringify(m.value)}`,
    );
  }
  console.log("");
}
