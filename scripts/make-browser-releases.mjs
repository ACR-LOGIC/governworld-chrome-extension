// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Per-browser release packaging: one verified artifact per browser family.
//
// Run from the repository root:
//   npm run release:browsers <commit>   # build all payloads + zip Chromium & Firefox
//
// Output (all recorded in release/BROWSER_SHA256SUMS, never fabricated):
//   release/GovernWorld-Chromium-v<V>-<sha>.zip (+ .tar.gz mirror)
//   release/GovernWorld-Firefox-v<V>-<sha>.zip  (+ .tar.gz mirror)
//   release/GovernWorld-Safari-handoff-v<V>-<sha>.zip (+ .tar.gz mirror)
//   release/BROWSER_SHA256SUMS
//
// The Safari handoff is a packaging *input*, not an installable extension:
// the payload plus docs/DEV-MODE-INSTALL.md staged as INSTALL.txt, for
// `xcrun safari-web-extension-packager` or the App Store Connect web
// packager. The "-handoff" suffix and the sums note say so explicitly, so no
// row reads as a distributable Safari release.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(root, "..");
const commit = process.argv[2];

if (!commit) {
  throw new Error(
    "Refusing to package an un-reviewed commit: pass the approved commit SHA explicitly, e.g. `npm run release:browsers <sha>`."
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

const dirty = execFileSync("git", ["status", "--porcelain"], shell).trim();
if (dirty.length > 0) {
  throw new Error(`Refusing to package a dirty working tree. Commit or stash changes first:\n${dirty}`);
}

console.log(`Packaging reviewed commit ${shortSha} for every browser target`);

execFileSync("npm", ["run", "build"], { shell: true, cwd: pkgRoot, stdio: "inherit" });
execFileSync("npm", ["run", "build:firefox"], { shell: true, cwd: pkgRoot, stdio: "inherit" });
execFileSync("npm", ["run", "build:safari"], { shell: true, cwd: pkgRoot, stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const version = pkg.version;

const releaseDir = join(pkgRoot, "release");
mkdirSync(releaseDir, { recursive: true });

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

const sums = [
  `GovernWorld per-browser release ${shortSha} (version ${version})`,
  "",
];

/** Zip + tar one payload directory. Returns the artifact file names. */
function packageTarget(family, distName) {
  const distDir = join(pkgRoot, distName);
  if (!existsSync(distDir)) throw new Error(`${distName}/ missing after build`);
  const base = `GovernWorld-${family}-v${version}-${shortSha}`;
  const outZip = join(releaseDir, `${base}.zip`);
  const outTar = join(releaseDir, `${base}.tar.gz`);
  if (existsSync(outZip)) rmSync(outZip);
  if (existsSync(outTar)) rmSync(outTar);
  execFileSync(
    "pwsh",
    ["-NoProfile", "-Command", `Compress-Archive -Path '${distDir}\\*' -DestinationPath '${outZip}'`],
    { cwd: pkgRoot, stdio: "inherit" }
  );
  execFileSync("tar", ["-czf", outTar, "-C", distDir, "."], { cwd: pkgRoot, stdio: "inherit" });
  console.log(`Release ${family}: ${outZip}`);
  sums.push(`${sha256(outZip)}  ${base}.zip`, `${sha256(outTar)}  ${base}.tar.gz`);
}

packageTarget("Chromium", "dist");
packageTarget("Firefox", "dist-firefox");

// Safari handoff: stage the payload plus the install rules, then package it
// under an explicit -handoff name. Not a distributable; see header comment.
{
  copyFileSync(
    join(pkgRoot, "docs", "DEV-MODE-INSTALL.md"),
    join(pkgRoot, "dist-safari", "INSTALL.txt")
  );
  packageTarget("Safari-handoff", "dist-safari");
  sums.push(
    "NOTE: Safari-handoff is a packaging input for Apple tooling, not an installable extension."
  );
}

sums.push("");
const sumsPath = join(releaseDir, "BROWSER_SHA256SUMS");
writeFileSync(sumsPath, sums.join("\n"));
console.log(`Checksums:  ${sumsPath}`);
