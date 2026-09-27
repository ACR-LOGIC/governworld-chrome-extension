// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUPPORTED_LANGUAGES,
  UI_TRANSLATIONS,
  CATEGORY_TRANSLATIONS,
  PRESET_TRANSLATIONS,
  t,
  getCategoryLabel,
  getPresetLabel,
  type LanguageCode,
} from "../src/shared/i18n.js";
import {
  normalizeSettings,
  resetSettings,
  DEFAULT_SETTINGS,
  ALL_CATEGORIES,
  PRESET_CATEGORIES,
  type FontSizeScale,
  type SessionTimeoutOption,
} from "../src/shared/settings.js";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("i18n Multi-Language Module", () => {
  it("supports all 7 required languages with metadata", () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(codes).toEqual(["en", "es", "fr", "de", "ja", "pt", "zh"]);
    for (const lang of codes) {
      expect(UI_TRANSLATIONS[lang]).toBeDefined();
      expect(CATEGORY_TRANSLATIONS[lang]).toBeDefined();
      expect(PRESET_TRANSLATIONS[lang]).toBeDefined();
    }
  });

  it("contains identical key structure across all language dictionaries with no empty strings", () => {
    const enKeys = Object.keys(UI_TRANSLATIONS.en).sort();
    expect(enKeys.length).toBeGreaterThan(40);

    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    for (const lang of codes) {
      const dict = UI_TRANSLATIONS[lang];
      for (const key of enKeys) {
        expect(dict[key], `Language ${lang} is missing key: ${key}`).toBeDefined();
        expect(typeof dict[key]).toBe("string");
        expect(dict[key].trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("t() translates and interpolates parameters accurately", () => {
    expect(t("en", "speech_scan_complete", { count: 5 })).toBe("Page scan complete. Found 5 sensitive data items.");
    expect(t("es", "speech_scan_complete", { count: 3 })).toBe("Escaneo completado. Se encontraron 3 elementos sensibles.");
    expect(t("fr", "speech_scan_complete", { count: 2 })).toBe("Analyse terminée. 2 éléments sensibles trouvés.");
    expect(t("de", "speech_scan_complete", { count: 4 })).toBe("Scan abgeschlossen. 4 sensible Einträge gefunden.");
    expect(t("ja", "speech_scan_complete", { count: 1 })).toBe("スキャンが完了しました。1件の機密データを検出しました。");
    expect(t("pt", "speech_scan_complete", { count: 8 })).toBe("Varredura concluída. 8 itens sensíveis encontrados.");
    expect(t("zh", "speech_scan_complete", { count: 9 })).toBe("页面扫描完成，共发现 9 处敏感数据。");
  });

  it("t() falls back gracefully to English when key is missing in target dictionary", () => {
    expect(t("es", "brand_title")).toBe("GovernWorld");
    expect(t("en", "non_existent_key_xyz")).toBe("non_existent_key_xyz");
  });

  it("getCategoryLabel translates all 20 categories across languages", () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    for (const cat of ALL_CATEGORIES) {
      for (const lang of codes) {
        const label = getCategoryLabel(lang, cat);
        expect(label).toBeTruthy();
        expect(typeof label).toBe("string");
      }
    }
  });

  it("getPresetLabel translates all presets across languages", () => {
    const presetKeys = Object.keys(PRESET_CATEGORIES);
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    for (const preset of [...presetKeys, "custom"]) {
      for (const lang of codes) {
        const label = getPresetLabel(lang, preset);
        expect(label).toBeTruthy();
        expect(typeof label).toBe("string");
      }
    }
  });
});

describe("Settings Accessibility & Preference Normalization", () => {
  it("normalizes language selection with fallback to 'en'", () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    for (const lang of codes) {
      expect(normalizeSettings({ language: lang }).language).toBe(lang);
    }
    expect(normalizeSettings({ language: "klingon" as unknown as LanguageCode }).language).toBe("en");
    expect(normalizeSettings({ language: "" as unknown as LanguageCode }).language).toBe("en");
  });

  it("normalizes font size with fallback to 'default'", () => {
    const validSizes: FontSizeScale[] = ["default", "medium", "large", "xlarge"];
    for (const size of validSizes) {
      expect(normalizeSettings({ fontSize: size }).fontSize).toBe(size);
    }
    expect(normalizeSettings({ fontSize: "huge" as unknown as FontSizeScale }).fontSize).toBe("default");
    expect(normalizeSettings({ fontSize: 123 as unknown as FontSizeScale }).fontSize).toBe("default");
  });

  it("normalizes accessibility booleans fail-closed", () => {
    const s1 = normalizeSettings({
      highContrast: true,
      dyslexiaMode: true,
      reducedMotion: true,
      speechAnnouncements: true,
      ariaVerboseMode: true,
      autoCopySanitized: true,
    });
    expect(s1.highContrast).toBe(true);
    expect(s1.dyslexiaMode).toBe(true);
    expect(s1.reducedMotion).toBe(true);
    expect(s1.speechAnnouncements).toBe(true);
    expect(s1.ariaVerboseMode).toBe(true);
    expect(s1.autoCopySanitized).toBe(true);

    const s2 = normalizeSettings({
      highContrast: "yes" as unknown as boolean,
      dyslexiaMode: 1 as unknown as boolean,
      reducedMotion: "true" as unknown as boolean,
      speechAnnouncements: null as unknown as boolean,
      ariaVerboseMode: undefined,
      autoCopySanitized: "no" as unknown as boolean,
    });
    expect(s2.highContrast).toBe(false);
    expect(s2.dyslexiaMode).toBe(false);
    expect(s2.reducedMotion).toBe(false);
    expect(s2.speechAnnouncements).toBe(false);
    expect(s2.ariaVerboseMode).toBe(false);
    expect(s2.autoCopySanitized).toBe(false);
  });

  it("normalizes maskColor fail-closed", () => {
    for (const color of ["#0f172a", "#000000", "#e11d48", "#2563eb", "#16a34a"]) {
      expect(normalizeSettings({ maskColor: color }).maskColor).toBe(color);
    }
    expect(normalizeSettings({ maskColor: "purple" }).maskColor).toBe("#0f172a");
    expect(normalizeSettings({ maskColor: "" }).maskColor).toBe("#0f172a");
  });

  it("normalizes sessionTimeout properly", () => {
    const validTimeouts: SessionTimeoutOption[] = ["never", "5m", "15m", "30m"];
    for (const to of validTimeouts) {
      expect(normalizeSettings({ sessionTimeout: to }).sessionTimeout).toBe(to);
    }
    expect(normalizeSettings({ sessionTimeout: "99min" as unknown as SessionTimeoutOption }).sessionTimeout).toBe("never");
    expect(normalizeSettings({ sessionTimeout: -1 as unknown as SessionTimeoutOption }).sessionTimeout).toBe("never");
  });

  it("normalizes document studio defaults", () => {
    expect(normalizeSettings({ defaultRedactionStyle: "stamp" }).defaultRedactionStyle).toBe("stamp");
    expect(normalizeSettings({ defaultRedactionStyle: "whiteout" }).defaultRedactionStyle).toBe("whiteout");
    expect(normalizeSettings({ defaultRedactionStyle: "invalid" as unknown as "blackout" }).defaultRedactionStyle).toBe("blackout");

    expect(normalizeSettings({ defaultStampText: "[SECRET]" }).defaultStampText).toBe("[SECRET]");
    expect(normalizeSettings({ defaultStampText: "   " }).defaultStampText).toBe("[REDACTED]");
  });

  it("resetSettings returns clean copy of DEFAULT_SETTINGS", async () => {
    const defaults = await resetSettings();
    expect(defaults).toEqual(DEFAULT_SETTINGS);
    expect(defaults.language).toBe("en");
    expect(defaults.fontSize).toBe("default");
    expect(defaults.highContrast).toBe(false);
    expect(defaults.dyslexiaMode).toBe(false);
    expect(defaults.reducedMotion).toBe(false);
    expect(defaults.speechAnnouncements).toBe(false);
  });
});

describe("HTML UI Parity for Accessibility & Settings", () => {
  const pages = ["src/popup/index.html", "src/sidepanel/sidepanel.html"];

  it.each(pages)("%s contains all accessibility and multi-language controls", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");

    // Language & Accessibility Selectors
    expect(html).toContain('id="lang-select"');
    expect(html).toContain('id="font-size-select"');
    expect(html).toContain('id="high-contrast-toggle"');
    expect(html).toContain('id="dyslexia-toggle"');
    expect(html).toContain('id="reduced-motion-toggle"');
    expect(html).toContain('id="speech-toggle"');
    expect(html).toContain('id="verbose-aria-toggle"');

    // Advanced Protection & Studio Defaults
    expect(html).toContain('id="mask-padding-select"');
    expect(html).toContain('id="mask-color-select"');
    expect(html).toContain('id="auto-copy-toggle"');
    expect(html).toContain('id="session-timeout-select"');
    expect(html).toContain('id="default-doc-style-select"');
    expect(html).toContain('id="default-doc-stamp-input"');

    // Storage & Reset Dialogs
    expect(html).toContain('id="reset-settings-btn"');
    expect(html).toContain('id="clear-audit-btn"');
    expect(html).toContain('id="reset-confirm-dialog"');
    expect(html).toContain('id="clear-audit-dialog"');
    expect(html).toContain('id="reset-confirm"');
    expect(html).toContain('id="reset-cancel"');
    expect(html).toContain('id="clear-audit-confirm"');
    expect(html).toContain('id="clear-audit-cancel"');
  });

  it.each(pages)("%s data-i18n attributes match valid dictionary keys", (pagePath) => {
    const html = readFileSync(join(extRoot, pagePath), "utf8");
    const i18nMatches = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);

    expect(i18nMatches.length).toBeGreaterThan(30);
    const enDict = UI_TRANSLATIONS.en;

    for (const key of i18nMatches) {
      expect(enDict[key], `${pagePath} has invalid data-i18n key: ${key}`).toBeDefined();
    }
  });
});
