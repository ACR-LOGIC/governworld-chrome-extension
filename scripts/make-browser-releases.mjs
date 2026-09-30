// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Per-browser release packaging: one verified artifact per browser family.
//
// Run from the repository root:
//   npm run release:browsers <commit>   # build all payloads + zip Chromium & Firefox
//
// Output (all recorded in release/BROWSER_SHA256SUMS, never fabricated):
//   release/GovernWorld-Chromium-v<V>-<sha>.zip (+ .tar.gz mirror)
//   release/GovernWorld-Firefox-v<V>-<sha>.zip  (+ .tar.gz mirror)
//   release/BROWSER_SHA256SUMS
//
// Safari gets no distributable here: packaging a Safari web extension into a
// signed app requires a Mac with Xcode or App Store Connect (Apple Developer
// Program), neither of which is available on this build machine. The
// dist-safari/ handoff payload is still built (so it cannot rot silently) and
// its manifest checksum is recorded in RELEASE_EVIDENCE.md, but no zip is
// presented as a Safari release artifact.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Safari handoff payload: built above so it cannot rot, checksummed by
// manifest for evidence, but NOT zipped as a release artifact.
{
  const manifest = readFileSync(join(pkgRoot, "dist-safari", "manifest.json"));
  sums.push(
    "",
    "Safari: no distributable artifact (requires Mac+Xcode or App Store Connect).",
    `Handoff payload manifest sha256: ${createHash("sha256").update(manifest).digest("hex").toUpperCase()}`
  );
}

sums.push("");
const sumsPath = join(releaseDir, "BROWSER_SHA256SUMS");
writeFileSync(sumsPath, sums.join("\n"));
console.log(`Checksums:  ${sumsPath}`);
