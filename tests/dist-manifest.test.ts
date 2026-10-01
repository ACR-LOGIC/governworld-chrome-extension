// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Dist contract: every path manifest.json resolves at runtime must exist in the
// built package. A missing entry point (service worker, popup, side panel,
// offscreen host) makes Chrome refuse to load the extension or silently fail a
// surface, and esbuild never surfaces that as an error. Asserted after
// `npm run build`; skipped on a clean checkout where dist/ does not exist.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(extRoot, "dist");
const manifestPath = join(dist, "manifest.json");

interface BuiltManifest {
  background: { service_worker: string; type?: string };
  action: { default_popup: string; default_icon: Record<string, string> };
  side_panel: { default_path: string };
  icons: Record<string, string>;
  content_security_policy: { extension_pages: string };
}

describe.skipIf(!existsSync(manifestPath))("built extension package", () => {
  const getManifest = (): BuiltManifest => JSON.parse(readFileSync(manifestPath, "utf8"));

  it("emits the declared MV3 service worker at the extension root", () => {
    const manifest = getManifest();
    expect(manifest.background.service_worker).toBe("service-worker.js");
    expect(existsSync(join(dist, manifest.background.service_worker))).toBe(true);
  });

  it("emits the action popup and its stylesheet", () => {
    const manifest = getManifest();
    expect(manifest.action.default_popup).toBe("popup.html");
    expect(existsSync(join(dist, manifest.action.default_popup))).toBe(true);
    expect(existsSync(join(dist, "popup.css"))).toBe(true);
  });

  it("emits the side panel and its stylesheet", () => {
    const manifest = getManifest();
    expect(manifest.side_panel.default_path).toBe("sidepanel.html");
    expect(existsSync(join(dist, manifest.side_panel.default_path))).toBe(true);
    expect(existsSync(join(dist, "sidepanel.css"))).toBe(true);
  });

  it("emits every declared icon at its declared size", () => {
    const manifest = getManifest();
    for (const [size, path] of Object.entries(manifest.icons)) {
      expect(existsSync(join(dist, path)), `icon-${size} missing at ${path}`).toBe(true);
    }
    for (const [size, path] of Object.entries(manifest.action.default_icon)) {
      expect(existsSync(join(dist, path)), `action icon-${size} missing at ${path}`).toBe(true);
    }
  });

  it("emits the offscreen host page and its module", () => {
    expect(existsSync(join(dist, "offscreen.html"))).toBe(true);
    expect(existsSync(join(dist, "offscreen.js"))).toBe(true);
  });

  it("emits the landing page with its external script, not an inline block", () => {
    expect(existsSync(join(dist, "landing.html"))).toBe(true);
    const landing = readFileSync(join(dist, "landing.html"), "utf8");
    expect(landing).toContain('src="landing.js"');
    expect(existsSync(join(dist, "landing.js")), "landing.js referenced but not emitted").toBe(true);
    const inline = [...landing.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
      ([, attrs, body]) => !/\bsrc\s*=/i.test(attrs) && body.trim().length > 0
    );
    expect(inline, "landing.html has an inline script, blocked by script-src 'self'").toEqual([]);
  });

  it("emits the bundled offline OCR and pdf.js assets", () => {
    for (const asset of [
      "assets/pdf.worker.min.mjs",
      "assets/tesseract.worker.min.js",
      "assets/tesseract-core.wasm.js",
      "assets/tesseract-core.wasm",
      "assets/tessdata/eng.traineddata.gz",
    ]) {
      expect(existsSync(join(dist, asset)), `missing bundled asset ${asset}`).toBe(true);
    }
  });

  it("ships the managed-policy schema the manifest declares", () => {
    const manifest = getManifest() as unknown as { storage?: { managed_schema?: string } };
    expect(manifest.storage?.managed_schema).toBe("schema/policy.json");
    expect(
      existsSync(join(dist, "schema", "policy.json")),
      "managed_schema target missing from dist/"
    ).toBe(true);
  });

  it("keeps the managed-policy schema loadable by Chrome", () => {
    // Chrome strictly validates the managed schema and refuses to load the
    // extension when the top-level object carries additionalProperties
    // ("Invalid type for attribute 'additionalProperties'").
    const schema = JSON.parse(readFileSync(join(dist, "schema", "policy.json"), "utf8")) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBeUndefined();
  });

  it("keeps a CSP that forbids inline and remote script", () => {
    const manifest = getManifest();
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src");
    expect(csp).toContain("'self'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toMatch(/script-src[^;]*\bhttps?:/);
  });

  it("does not ship dynamic code evaluation", () => {
    for (const script of ["service-worker.js", "content.js", "popup.js", "sidepanel.js", "landing.js"]) {
      const source = readFileSync(join(dist, script), "utf8");
      expect(source, `${script} calls eval`).not.toMatch(/\beval\s*\(/);
      expect(source, `${script} builds functions dynamically`).not.toMatch(/\bnew\s+Function\b/);
    }
  });
});
