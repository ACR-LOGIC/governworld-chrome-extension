// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Firefox package contract: dist-firefox/ must be a loadable Firefox
// extension with the locked add-on ID, and must not carry Chromium-only
// manifest keys that would fail installation. Skipped when dist-firefox/
// is absent — run after `npm run build:firefox`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(extRoot, "dist-firefox");
const manifestPath = join(dist, "manifest.json");

/** The add-on ID, locked deliberately. Never regenerated (see BROWSER_SUPPORT.md). */
export const LOCKED_FIREFOX_ADDON_ID = "redaction@governworld.acrlogic.com";

describe.skipIf(!existsSync(manifestPath))("firefox extension package", () => {
  const getManifest = (): any => JSON.parse(readFileSync(manifestPath, "utf8"));
  const pkg = JSON.parse(readFileSync(join(extRoot, "package.json"), "utf8"));

  it("carries the locked add-on ID and the package version", () => {
    const manifest = getManifest();
    expect(manifest.browser_specific_settings?.gecko?.id).toBe(LOCKED_FIREFOX_ADDON_ID);
    expect(manifest.version).toBe(pkg.version);
  });

  it("uses event-page background scripts Firefox installs, not a service worker", () => {
    const manifest = getManifest();
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background?.scripts).toContain("service-worker.js");
    expect(manifest.background?.service_worker).toBeUndefined();
    expect(existsSync(join(dist, "service-worker.js"))).toBe(true);
  });

  it("exposes the panel as a sidebar action", () => {
    const manifest = getManifest();
    expect(manifest.sidebar_action?.default_panel).toBe("sidepanel.html");
    expect(existsSync(join(dist, "sidepanel.html"))).toBe(true);
    expect(existsSync(join(dist, "popup.html"))).toBe(true);
  });

  it("declares no Chromium-only permission keys", () => {
    const manifest = getManifest();
    for (const key of ["offscreen", "sidePanel"]) {
      expect(manifest.permissions ?? []).not.toContain(key);
    }
    // Runtime-only site access for always-on, same as Chromium.
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(
      expect.arrayContaining(["http://*/*", "https://*/*"])
    );
  });

  it("ships the offline OCR/pdf.js assets with the content and UI bundles", () => {
    for (const asset of [
      "content.js",
      "popup.js",
      "sidepanel.js",
      "assets/pdf.worker.min.mjs",
      "assets/tesseract.worker.min.js",
      "assets/tesseract-core.wasm",
      "assets/tessdata/eng.traineddata.gz",
    ]) {
      expect(existsSync(join(dist, asset)), `missing firefox asset ${asset}`).toBe(true);
    }
  });

  it("keeps a CSP that forbids inline and remote script", () => {
    const manifest = getManifest();
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src");
    expect(csp).toContain("'self'");
    expect(csp).not.toContain("'unsafe-inline'");
  });
});
