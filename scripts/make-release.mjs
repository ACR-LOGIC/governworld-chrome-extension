// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Release packaging for the Chrome Web Store.
// Builds from the current (reviewed) commit and zips the exact dist output.
// Run from apps/redaction-extension:
//   npm run release:zip            # build + zip current HEAD
//   npm run release:zip <commit>   # build + zip a specific reviewed commit
// Output: release/governworld-redaction-<commit>.zip
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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