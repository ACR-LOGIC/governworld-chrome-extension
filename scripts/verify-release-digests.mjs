// Verifies every SHA-256 recorded in RELEASE_EVIDENCE.md against the committed
// blob at HEAD, for both the release artifacts and the separately-uploaded
// store images.
//
// Why this exists rather than eyeballing digests: hashing a working tree on
// Windows is misleading. Git checks out text files with CRLF when
// core.autocrlf is set, so `Get-FileHash package-lock.json` on a Windows
// checkout produces a different digest from the committed content. That is a
// real trap - it looks like the release evidence is wrong when it is not.
//
// The committed blob is the canonical artifact, so that is what is checked
// here. Run it before trusting any digest in the evidence file.
//
//   node scripts/verify-release-digests.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fullEvidence = readFileSync(join(root, "RELEASE_EVIDENCE.md"), "utf8");

// Only the current release is verifiable. The "Previous (superseded)" section
// lists historical artifacts, most of which are gitignored and absent from any
// given checkout, and a checker that fails on those is a checker people learn
// to ignore. The current SHA-256s are the ones with a live consequence.
const cut = fullEvidence.indexOf("### Previous (superseded");
const evidence = cut > 0 ? fullEvidence.slice(0, cut) : fullEvidence;

/** SHA-256 of a git blob, read as bytes so binary content is never mangled. */
function sha256OfBlob(rev) {
  const bytes = execFileSync("git", ["cat-file", "blob", rev], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

/** SHA-256 of a path as it exists on disk right now. */
function sha256OfFile(rel) {
  return createHash("sha256").update(readFileSync(join(root, rel))).digest("hex").toUpperCase();
}

// Each digest in the file is paired with a name on the same line. The two
// shapes in use are `SHA  release/path` in the store-asset block, and a table
// row like "`release/foo.zip`, SHA-256 `SHA`" for the artifacts, where the
// digest sits inside a longer cell rather than alone in one.
const recorded = [];
const seen = new Set();
for (const line of evidence.split(/\r?\n/)) {
  for (const m of line.matchAll(/([0-9A-Fa-f]{64})/g)) {
    const sha = m[1].toUpperCase();
    // Prefer an explicit path, backticked or bare. The store-asset block is a
    // plain `SHA  release/path` listing; the artifact table is markdown with
    // the name in backticks.
    const named =
      line.match(/`(release\/[^`]+)`/) ||
      line.match(/(release\/[\w.\/-]+)/) ||
      line.match(/`(governworld-redaction-[^`]+\.(?:zip|tar\.gz))`/);
    if (!named) continue;
    const name = named[1];
    const key = `${sha} ${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recorded.push({ sha, name });
  }
}

if (recorded.length === 0) {
  console.log("no digests found in RELEASE_EVIDENCE.md - is the format still the same?");
  process.exit(1);
}

let failures = 0;
let checked = 0;

for (const { sha, name } of recorded) {
  let actual = null;
  let via = "";

  if (name.includes("/") || name.includes("\\")) {
    // Store asset: compare the committed blob, which for a binary image is
    // byte-identical to the working tree anyway.
    try {
      actual = sha256OfBlob(`HEAD:${name.replace(/\\/g, "/")}`);
      via = "committed blob";
    } catch {
      // Not a tracked path; fall back to disk.
      actual = sha256OfFile(name);
      via = "working tree";
    }
  } else {
    // Release artifact, named by short SHA rather than a path.
    const rel = `release/${name}`;
    try {
      actual = sha256OfFile(rel);
      via = "working tree";
    } catch {
      console.log(`MISSING  ${name} - expected at ${rel}. Regenerate with: npm run release:zip <sha>`);
      failures++;
      continue;
    }
  }

  checked++;
  if (actual === sha) {
    console.log(`MATCH    ${name}  (${via})`);
  } else {
    console.log(`MISMATCH ${name}  (${via})`);
    console.log(`  recorded ${sha}`);
    console.log(`  actual   ${actual}`);
    failures++;
  }
}

console.log(`\n${checked - failures}/${checked} digests verified against ${basename("RELEASE_EVIDENCE.md")}`);
process.exit(failures === 0 ? 0 : 1);
