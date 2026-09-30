// Firefox is a supported release target with its own manifest shape.
//
// manifest.firefox.json is the Firefox MV3 source manifest: event-page
// background scripts (Firefox runs MV3 background contexts as documents),
// sidebar_action instead of sidePanel, and no Chromium-only permission keys
// that would fail installation. The Document Studio limitation (no offscreen
// API on Firefox) is a runtime error path, not a manifest property — see
// src/shared/platform.ts.
//
// The gecko ID below is locked deliberately and must never be regenerated:
// changing it after publication breaks upgrades. It must also match the gecko
// block in manifest.json so the two packages never claim different identities.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

const LOCKED_GECKO_ID = "redaction@governworld.acrlogic.com";

describe("the Firefox source manifest", () => {
  const ff = readJson("manifest.firefox.json") as {
    manifest_version: number;
    version: string;
    permissions: string[];
    background?: Record<string, unknown>;
    browser_specific_settings?: { gecko?: { id?: string } };
  };
  const v3 = readJson("manifest.json") as {
    manifest_version: number;
    permissions: string[];
    browser_specific_settings?: { gecko?: { id?: string } };
  };
  const pkg = readJson("package.json") as { version: string };

  it("is Manifest V3 and tracks the package version", () => {
    expect(ff.manifest_version).toBe(3);
    expect(ff.version).toBe(pkg.version);
  });

  it("carries the locked add-on ID, matching the Chromium manifest", () => {
    expect(ff.browser_specific_settings?.gecko?.id).toBe(LOCKED_GECKO_ID);
    expect(v3.browser_specific_settings?.gecko?.id).toBe(LOCKED_GECKO_ID);
  });

  it("uses event-page background scripts Firefox installs", () => {
    expect(ff.background?.scripts).toContain("service-worker.js");
    expect(ff.background?.service_worker).toBeUndefined();
  });

  it("keeps scripting for activeTab injection, without Chromium-only keys", () => {
    expect(ff.permissions).toContain("scripting");
    expect(ff.permissions).toContain("activeTab");
    for (const unsupported of ["offscreen", "sidePanel"]) {
      expect(ff.permissions, `Firefox manifest must not declare ${unsupported}`).not.toContain(
        unsupported
      );
    }
  });

  it("is packaged deliberately by the Firefox build, never by the Chromium build", () => {
    expect(readFileSync("scripts/build-firefox.mjs", "utf8")).toMatch(/manifest\.firefox\.json/);
    expect(readFileSync("build.mjs", "utf8"), "Chromium build must not reference Firefox").not.toMatch(
      /firefox/i
    );
  });
});
