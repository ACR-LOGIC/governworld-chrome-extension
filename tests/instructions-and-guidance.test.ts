// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Instructions, Tab Navigation & Contextual Guidance", () => {
  const pages = ["src/popup/index.html", "src/sidepanel/sidepanel.html"];

  it.each(pages)("%s declares the 4 primary tabs with proper roles", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");
    for (const tab of ["protection", "logic", "review", "settings"]) {
      expect(html, `${pagePath} missing tab button for ${tab}`).toContain(`data-tab="${tab}"`);
      expect(html, `${pagePath} missing tab panel for ${tab}`).toContain(`id="tab-${tab}"`);
    }
  });

  it.each(pages)("%s contains contextual help links that resolve to valid guide cards", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");
    const guideLinks = [...html.matchAll(/data-guide="([^"]+)"/g)].map((m) => m[1]);
    expect(guideLinks.length).toBeGreaterThan(4);

    for (const guideId of guideLinks) {
      expect(html, `${pagePath} has broken help link for #${guideId}`).toContain(`id="${guideId}"`);
    }
  });

  it.each(pages)("%s includes all required guidance sections in the instructions tab", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");
    const expectedSections = [
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
      "guide-paste-guard",
      "guide-context-menus",
      "guide-ocr-languages",
      "guide-redaction-styles",
      "guide-accessibility",
      "guide-languages",
      "guide-settings",
      "guide-shortcuts",
      "guide-troubleshooting",
    ];

    for (const sectionId of expectedSections) {
      expect(html, `${pagePath} missing guide section #${sectionId}`).toContain(`id="${sectionId}"`);
    }
  });

  it.each(pages)("%s provides Support & Contributions details with Buy Me a Coffee link", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");
    expect(html).toContain('id="contributions-details"');
    expect(html).toContain('href="https://buymeacoffee.com/governworld"');
  });

  it.each(pages)("%s retains locked cloud mode with API-ready gateway settings", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");
    expect(html).toContain('id="mode-local"');
    expect(html).toContain('id="mode-cloud"');
    expect(html).toContain('disabled');
    expect(html).toContain('id="gateway-origin-input"');
    expect(html).toContain('id="gateway-key-input"');
  });

  it.each(pages)("%s provides the interactive Redaction Wizard dialog", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");
    expect(html).toContain('id="wizard-dialog"');
    expect(html).toContain('id="wizard-pos-input"');
    expect(html).toContain('id="wizard-neg-input"');
    expect(html).toContain('id="wizard-analyze-btn"');
    expect(html).toContain('id="wizard-regex-input"');
    expect(html).toContain('id="wizard-test-sample"');
    expect(html).toContain('id="wizard-rule-name"');
    expect(html).toContain('id="wizard-save-btn"');
  });
});
