// The Firefox manifest is an orphan and must stay that way until a real port
// exists.
//
// `manifest.firefox.json` is Manifest V2 with a reduced permission set, and the
// build does not reference it, package it, or test it. It also lacks the
// offscreen document the document pipeline depends on, so the core of the
// extension - PDF and image redaction - could not work under it. The README
// already says Firefox is not supported.
//
// That is currently a documentation claim. These tests make it structural: if
// someone ever wires the build to this file, they fail, which forces a
// deliberate decision rather than an accidental release. The file is kept
// because it records intent, and it is inert either way.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

describe("the Firefox manifest cannot be shipped by accident", () => {
  it("is not referenced by the build", () => {
    expect(readFileSync("build.mjs", "utf8"), "build.mjs now packages the Firefox manifest").not.toMatch(
      /firefox/i,
    );
  });

  it("is not present in the built output", () => {
    if (!existsSync("dist")) return; // clean checkout; the dist gates cover the built case
    const firefox = readdirSync("dist").filter((f) => /firefox/i.test(f));
    expect(firefox, "a Firefox manifest reached dist/").toEqual([]);
  });

  it("is Manifest V2 and lacks the permissions the pipeline needs", () => {
    const ff = readJson("manifest.firefox.json") as { manifest_version: number; permissions: string[] };
    const v3 = readJson("manifest.json") as { manifest_version: number; permissions: string[] };

    expect(v3.manifest_version, "the shipping manifest must stay MV3").toBe(3);
    expect(ff.manifest_version).toBe(2);

    // These three are what make the document pipeline possible. Their absence is
    // the substantive reason this manifest cannot be a shipping target, beyond
    // the version number.
    for (const required of ["offscreen", "sidePanel", "scripting"]) {
      expect(v3.permissions, `MV3 manifest lost ${required}`).toContain(required);
      expect(ff.permissions, `the Firefox file unexpectedly requests ${required}`).not.toContain(required);
    }
  });

  it("declares a different extension id, so the two are not interchangeable", () => {
    const ff = readJson("manifest.firefox.json") as {
      browser_specific_settings?: { gecko?: { id?: string } };
    };
    expect(ff.browser_specific_settings?.gecko?.id).toBe("redaction@governworld.acrlogic.com");
  });
});
