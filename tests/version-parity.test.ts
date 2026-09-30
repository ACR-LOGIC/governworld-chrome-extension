// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Version parity: one shipped version everywhere.
//
// The API client sends CURRENT_EXTENSION_VERSION as X-Extension-Version and
// the health gate compares it against the server's minimum, so a stale
// constant silently misreports the build and mis-evaluates the kill switch.
// The Firefox manifest and the landing spec table drifted the same way, so
// all of them are pinned to package.json here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURRENT_EXTENSION_VERSION } from "../src/api/config.js";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (p: string): any => JSON.parse(readFileSync(join(extRoot, p), "utf8"));

describe("version parity", () => {
  it("ships one version across manifests, client header, and lockfile", () => {
    const pkg = json("package.json");
    const mv3 = json("manifest.json");
    const firefox = json("manifest.firefox.json");
    const lock = json("package-lock.json");
    expect(CURRENT_EXTENSION_VERSION).toBe(pkg.version);
    expect(mv3.version).toBe(pkg.version);
    expect(firefox.version).toBe(pkg.version);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.[""]?.version ?? lock.version).toBe(pkg.version);
  });

  it("landing page spec table names the shipped version", () => {
    const pkg = json("package.json");
    const landing = readFileSync(join(extRoot, "src/landing/index.html"), "utf8");
    expect(landing).toContain(`<td>${pkg.version}</td>`);
  });
});
