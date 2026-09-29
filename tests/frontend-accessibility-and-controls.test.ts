// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_OCR_CODES } from "../src/shared/ocrLanguages.js";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Frontend Design, Controls & Accessibility (Popup & Sidepanel Parity)", () => {
  const pages = ["src/popup/index.html", "src/sidepanel/sidepanel.html"];

  it.each(pages)("%s contains all new backend capability controls and UI elements", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");

    // Proactive Paste & Prompt Shield Banner
    expect(html).toContain('id="scanner-shield-status"');
    expect(html).toContain('id="scanner-shield-label"');

    // Context Menus Tip / Guide Card Link
    expect(html).toContain('data-guide="guide-context-menus"');

    // Category Quick Filters
    expect(html).toContain('id="cat-filter-all"');
    expect(html).toContain('id="cat-filter-health"');
    expect(html).toContain('id="cat-filter-intl"');
    expect(html).toContain('id="cat-filter-finance"');
    expect(html).toContain('id="cat-filter-none"');

    // Document Studio Canvas Toolbar & Redaction Style / OCR Options
    expect(html).toContain('id="tool-draw-box"');
    expect(html).toContain('id="tool-clear-custom"');
    expect(html).toContain('id="tool-toggle-all-doc"');
    expect(html).toContain('id="doc-style-select"');
    expect(html).toContain('id="doc-stamp-text"');
    expect(html).toContain('id="doc-stamp-presets"');
    expect(html).toContain('id="doc-ocr-language-select"');

    // Settings OCR Selector
    expect(html).toContain('id="ocr-language-select"');
  });

  it.each(pages)("%s adheres to accessibility standards (ARIA roles, live regions, labels)", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");

    // Static switches have role="switch" and aria-checked
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');

    // Check Document Studio toolbar accessibility
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Document Studio canvas tools"');

    // Check Live status region
    expect(html).toContain('aria-live="polite"');

    // Check Category quick filter toolbar
    expect(html).toContain('aria-label="Quick category filters"');
  });

    it.each(pages)("%s offers only OCR languages whose data is bundled", (pagePath) => {
      // This previously asserted six hard-coded language codes with
      // `html.toContain('value="spa"')`, which never actually looked at the OCR
      // dropdown: `value="spa"` also appears in the compliance-preset select, so
      // the assertion passed no matter what the dropdown said. Meanwhile the
      // build vendored only English traineddata, so five of the six offered
      // languages silently ran English OCR.
      //
      // The real property is that the dropdown and the package agree. Scope to
      // the OCR selects and compare against the declared set, which
      // ocr-bundled-languages.test.ts ties to vendor/tessdata.
      const html = readFileSync(join(extRoot, pagePath), "utf8");
      const selects = html.match(/<select[^>]*id="(?:doc-)?ocr-language-select"[\s\S]*?<\/select>/g) ?? [];
      expect(selects.length, `${pagePath} has no OCR language select`).toBeGreaterThan(0);
      for (const select of selects) {
        const offered = [...select.matchAll(/<option value="([a-z]{3})"/g)].map((m) => m[1]);
        expect(offered.length, "OCR select has no options in markup").toBeGreaterThan(0);
        const undeclared = offered.filter((code) => !BUNDLED_OCR_CODES.includes(code));
        expect(undeclared, `${pagePath} offers unbundled OCR languages: ${undeclared.join(", ")}`).toEqual([]);
      }
    });

  it.each(pages)("%s provides complete Redaction Style & Stamp Presets dropdowns", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");

    // Redaction styles
    expect(html).toContain('value="blackout"');
    expect(html).toContain('value="whiteout"');
    expect(html).toContain('value="stamp"');

    // Stamp presets
    const expectedPresets = ["[REDACTED]", "[CONFIDENTIAL]", "[PHI REMOVED]", "[PII MASKED]", "[RESTRICTED]", "[DE-IDENTIFIED]"];
    for (const preset of expectedPresets) {
      expect(html).toContain(`value="${preset}"`);
    }
  });

  it.each(pages)("%s includes documentation guides for all advanced backend capabilities", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");
    const requiredGuideIds = [
      "guide-paste-guard",
      "guide-context-menus",
      "guide-ocr-languages",
      "guide-redaction-styles",
      "guide-overview",
      "guide-local-mode",
      "guide-page-scan",
      "guide-masking",
      "guide-doc-redact",
      "guide-verification",
      "guide-wizard",
      "guide-categories",
      "guide-cloud",
      "guide-privacy",
      "guide-contributions",
    ];

    for (const id of requiredGuideIds) {
      expect(html, `${pagePath} missing #${id}`).toContain(`id="${id}"`);
    }
  });

  it.each(pages)("%s has all compliance presets configured in the dropdown", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");
    const expectedPresets = [
      "custom",
      "hipaa",
      "pci",
      "gdpr",
      "pipeda",
      "uk_gdpr",
      "india_dpdp",
      "australia_privacy",
      "brazil_lgpd",
      "developer",
    ];

    for (const preset of expectedPresets) {
      expect(html).toContain(`value="${preset}"`);
    }
  });

  it.each(pages)("%s has accessible dialog headers and labels", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");
    const dialogs = [...html.matchAll(/<dialog\s+id="([^"]+)"[^>]*>/g)];
    expect(dialogs.length).toBeGreaterThanOrEqual(4);

    for (const match of dialogs) {
      const fullTag = match[0];
      const hasAriaLabel = /aria-labelledby="[^"]+"|aria-label="[^"]+"/.test(fullTag);
      expect(hasAriaLabel, `Dialog tag ${fullTag} missing aria-labelledby or aria-label`).toBe(true);
    }
  });

  it("ensures exact UI ID parity between popup and sidepanel", () => {
    const popupHtml = readFileSync(join(extRoot, "src/popup/index.html"), "utf8");
    const sidepanelHtml = readFileSync(join(extRoot, "src/sidepanel/sidepanel.html"), "utf8");

    const extractIds = (html: string) =>
      new Set(
        [...html.matchAll(/id="([^"]+)"/g)]
          .map((m) => m[1])
          .filter((id) => !id.startsWith("gwshield-") && id !== "open-side-panel-btn")
      );

    const popupIds = extractIds(popupHtml);
    const sidepanelIds = extractIds(sidepanelHtml);

    // Every interactive ID in popup must be in sidepanel
    for (const id of popupIds) {
      expect(sidepanelIds.has(id), `Sidepanel is missing ID: #${id}`).toBe(true);
    }
  });

  it("properly resolves presetForCategories and category filter constants", async () => {
    const { presetForCategories, HEALTHCARE_CATEGORIES, INTERNATIONAL_CATEGORIES, FINANCIAL_CATEGORIES } = await import(
      "../src/popup/popup.js"
    );
    const { PRESET_CATEGORIES } = await import("../src/shared/settings.js");

    for (const [presetId, cats] of Object.entries(PRESET_CATEGORIES)) {
      expect(presetForCategories(cats)).toBe(presetId);
    }

    expect(presetForCategories(["email"])).toBe("custom");
    expect(HEALTHCARE_CATEGORIES).toContain("uk_nhs");
    expect(INTERNATIONAL_CATEGORIES).toContain("canadian_sin");
    expect(INTERNATIONAL_CATEGORIES).toContain("aadhaar");
    expect(INTERNATIONAL_CATEGORIES).toContain("pan_india");
    expect(INTERNATIONAL_CATEGORIES).toContain("australian_tfn");
    expect(INTERNATIONAL_CATEGORIES).toContain("cpf");
    expect(FINANCIAL_CATEGORIES).toContain("payment_card");
  });
});

