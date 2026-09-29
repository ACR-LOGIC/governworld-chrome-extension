// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Release packaging for the Chrome Web Store.
// Builds from the current (reviewed) commit and archives the exact dist output.
// Run from the repository root:
//   npm run release:zip            # build + zip current HEAD
//   npm run release:zip <commit>   # build + zip a specific reviewed commit
// Output:
//   release/governworld-redaction-<commit>.zip      (what the store accepts)
//   release/governworld-redaction-<commit>.tar.gz   (same payload, for mirrors)
//   release/SHA256SUMS                               (checksums for both)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(root, "..");
const commit = process.argv[2];

if (!commit) {
  throw new Error(
    "Refusing to package an un-reviewed commit: pass the approved commit SHA explicitly, e.g. `npm run release:zip <sha>`."
  );
}

const shell = { shell: true, cwd: pkgRoot, encoding: "utf8" };
const shortSha = execFileSync("git", ["rev-parse", "--short", commit], shell).trim();

{
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], shell).trim();
  const targetSha = execFileSync("git", ["rev-parse", commit], shell).trim();
  if (headSha !== targetSha) {
    throw new Error(`Refusing to package un-reviewed commit: HEAD is ${headSha}, requested ${targetSha}. Check out the reviewed commit first.`);
  }
}

// The build consumes the working tree, so refuse to package a dirty tree:
// only the reviewed commit's exact content may be shipped.
const dirty = execFileSync("git", ["status", "--porcelain"], shell).trim();
if (dirty.length > 0) {
  throw new Error(`Refusing to package a dirty working tree. Commit or stash changes first:\n${dirty}`);
}

console.log(`Packaging reviewed commit ${shortSha}`);

execFileSync("npm", ["run", "build"], { shell: true, cwd: pkgRoot, stdio: "inherit" });

const distDir = join(pkgRoot, "dist");
if (!existsSync(distDir)) throw new Error("dist/ missing after build");

const releaseDir = join(pkgRoot, "release");
mkdirSync(releaseDir, { recursive: true });
const outZip = join(releaseDir, `governworld-redaction-${shortSha}.zip`);
if (existsSync(outZip)) rmSync(outZip);

// Windows: Compress-Archive is built in. Content is zipped so the zip root
// contains the extension files directly (Chrome Web Store package format).
execFileSync(
  "pwsh",
  [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${distDir}\\*' -DestinationPath '${outZip}'`,
  ],
  { cwd: pkgRoot, stdio: "inherit" }
);
console.log(`Release zip: ${outZip}`);

// Same payload as a gzip tar, for mirrors that prefer it. Built from the same
// dist/ so the two can never disagree, and -C dist keeps the archive root flat
// like the zip. Windows bsdtar has no --sort/--owner, so timestamps and ownership
// are whatever the platform writes; the SHA256SUMS file below is the integrity
// record, not reproducibility of the bytes.
const outTar = join(releaseDir, `governworld-redaction-${shortSha}.tar.gz`);
if (existsSync(outTar)) rmSync(outTar);
execFileSync("tar", ["-czf", outTar, "-C", distDir, "."], { cwd: pkgRoot, stdio: "inherit" });
console.log(`Release tar: ${outTar}`);

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}
const artifacts = [outZip, outTar].filter((f) => existsSync(f));
const sums = [
  `GovernWorld Redaction release ${shortSha}`,
  `manifest version: ${JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8")).version}`,
  "",
  ...artifacts.map((f) => `${sha256(f)}  ${f.split(/[\\/]/).pop()}`),
  "",
].join("\n");
const sumsPath = join(releaseDir, "SHA256SUMS");
writeFileSync(sumsPath, sums);
console.log(`Checksums:  ${sumsPath}`);
for (const line of sums.split("\n").filter((l) => /^[0-9A-F]{64}/.test(l))) {
  console.log(`  ${line}`);
}