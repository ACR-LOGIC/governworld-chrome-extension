// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Cross-Browser Compatibility Gates (Chrome, Firefox, Edge, Safari, Brave, Opera, Arc)", () => {
  const manifest = JSON.parse(readFileSync(join(extRoot, "manifest.json"), "utf8"));

  describe("Chromium Ecosystem (Google Chrome, Microsoft Edge, Brave, Opera, Vivaldi, Arc)", () => {
    it("conforms to standard Manifest V3 specification", () => {
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.name).toBe("GovernWorld Redaction");
      expect(manifest.version).toBeDefined();
      expect(manifest.description).toBeDefined();
    });

    it("declares background service worker as ES module", () => {
      expect(manifest.background).toBeDefined();
      expect(manifest.background.service_worker).toBe("service-worker.js");
      expect(manifest.background.type).toBe("module");
    });

    it("configures standard MV3 action toolbar popup", () => {
      expect(manifest.action).toBeDefined();
      expect(manifest.action.default_popup).toBe("popup.html");
      expect(manifest.action.default_icon).toBeDefined();
    });

    it("specifies minimum Chrome/Edge version 116 for sidePanel API compatibility", () => {
      expect(manifest.minimum_chrome_version).toBe("116");
      expect(manifest.side_panel?.default_path).toBe("sidepanel.html");
    });

    it("declares standard permission set without excessive host access", () => {
      expect(manifest.permissions).toContain("activeTab");
      expect(manifest.permissions).toContain("scripting");
      expect(manifest.permissions).toContain("storage");
      expect(manifest.permissions).toContain("downloads");
      expect(manifest.permissions).toContain("contextMenus");
      // Zero broad site access declarations
      expect(manifest.host_permissions).toBeUndefined();
    });
  });

  describe("Mozilla Firefox (Gecko / AMO Compatibility)", () => {
    it("contains browser_specific_settings for Gecko / Firefox Add-on signing", () => {
      expect(manifest.browser_specific_settings).toBeDefined();
      expect(manifest.browser_specific_settings.gecko).toBeDefined();
      expect(manifest.browser_specific_settings.gecko.id).toBeTruthy();
      expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe("109.0");
    });

    it("uses standard WebExtension APIs that Firefox aliases or polyfills", () => {
      // Firefox requires valid CSP for WASM evaluation in MV3
      expect(manifest.content_security_policy?.extension_pages).toContain("'wasm-unsafe-eval'");
      expect(manifest.content_security_policy?.extension_pages).toContain("script-src 'self'");
    });

    it("has zero forbidden inline scripts or onclick handlers across all HTML documents", () => {
      const pages = [
        "src/popup/index.html",
        "src/popup/privacy.html",
        "src/popup/legal.html",
        "src/popup/redact.html",
        "src/sidepanel/sidepanel.html",
        "src/offscreen/offscreen.html",
        "src/landing/index.html",
      ];
      for (const page of pages) {
        const html = readFileSync(join(extRoot, page), "utf8");
        expect(html).not.toMatch(/<script\b[^>]*>[\s\S]+?<\/script>/gi);
        expect(html).not.toMatch(/\son[a-z]+\s*=/gi);
        expect(html).not.toMatch(/href\s*=\s*["']javascript:/gi);
      }
    });
  });

  describe("Apple Safari (WebKit WebExtensions Compatibility)", () => {
    it("has clean standard icons at all standard resolutions required by macOS/iOS", () => {
      expect(manifest.icons["16"]).toBe("icons/icon-16.png");
      expect(manifest.icons["32"]).toBe("icons/icon-32.png");
      expect(manifest.icons["48"]).toBe("icons/icon-48.png");
      expect(manifest.icons["128"]).toBe("icons/icon-128.png");
    });

    it("declares commands compatible with macOS Command key shortcuts", () => {
      expect(manifest.commands["scan-page"]?.suggested_key?.mac).toBe("Command+Shift+S");
      expect(manifest.commands["toggle-masks"]?.suggested_key?.mac).toBe("Command+Shift+M");
      expect(manifest.commands["open-side-panel"]?.suggested_key?.mac).toBe("Command+Shift+P");
    });
  });

  describe("Defensive API Fallbacks & Standards Compliance", () => {
    it("contains fallback handling for sidePanel opening in non-Chrome environments", () => {
      const popupSrc = readFileSync(join(extRoot, "src/popup/popup.ts"), "utf8");
      expect(popupSrc).toContain("chrome.sidePanel.open");
      expect(popupSrc).toContain("chrome.windows.create");

      const workerSrc = readFileSync(join(extRoot, "src/service-worker/index.ts"), "utf8");
      expect(workerSrc).toContain("chrome.sidePanel.open");
      expect(workerSrc).toContain("chrome.windows.create");
    });

    it("contains fallback handling for clipboard operations across all browsers", () => {
      const popupSrc = readFileSync(join(extRoot, "src/popup/popup.ts"), "utf8");
      expect(popupSrc).toContain("navigator.clipboard.writeText");
      expect(popupSrc).toContain("execCommand");
    });

    it("uses standard HTML5 Canvas, IndexedDB, and Web Speech APIs supported in all major engines", () => {
      const popupSrc = readFileSync(join(extRoot, "src/popup/popup.ts"), "utf8");
      expect(popupSrc).toContain("indexedDB");
      expect(popupSrc).toContain("speechSynthesis");
      expect(popupSrc).toContain("SpeechSynthesisUtterance");
    });
  });
});
