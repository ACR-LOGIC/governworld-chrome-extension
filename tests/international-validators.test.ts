// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  isValidCanadianSin,
  isValidNhsNumber,
  isValidAadhaar,
  isValidPanIndia,
  isValidAustralianTfn,
  isValidCpf,
} from "../src/validators/index.js";
import { detect, maskValue, placeholderLabelFor } from "../src/content/detect.js";
import { ALL_CATEGORIES, PRESET_CATEGORIES, PRESET_LABELS, type PresetId } from "../src/shared/settings.js";

describe("International Validators - Direct Validation", () => {
  describe("Canadian SIN", () => {
    it("validates genuine Luhn-compliant 9-digit SINs", () => {
      // 046 454 286 is Luhn valid but starts with 0 (not allowed)
      expect(isValidCanadianSin("046-454-286")).toBe(false);
      // Valid SIN starting with 1..7 or 9
      expect(isValidCanadianSin("130 692 908")).toBe(true);
      expect(isValidCanadianSin("130-692-908")).toBe(true);
      expect(isValidCanadianSin("130692908")).toBe(true);
    });

    it("rejects invalid SINs (wrong length, starts with 0 or 8, failed checksum)", () => {
      expect(isValidCanadianSin("830-692-908")).toBe(false); // starts with 8
      expect(isValidCanadianSin("130-692-909")).toBe(false); // bad checksum
      expect(isValidCanadianSin("130-692-90")).toBe(false); // short
    });
  });

  describe("UK NHS Number", () => {
    it("validates Mod-11 compliant 10-digit NHS numbers", () => {
      expect(isValidNhsNumber("943 476 5919")).toBe(true);
      expect(isValidNhsNumber("943-476-5919")).toBe(true);
      expect(isValidNhsNumber("9434765919")).toBe(true);
    });

    it("rejects invalid NHS numbers", () => {
      expect(isValidNhsNumber("943 476 5918")).toBe(false); // bad check digit
      expect(isValidNhsNumber("12345")).toBe(false);
    });
  });

  describe("Indian Aadhaar Number", () => {
    it("validates Verhoeff-compliant 12-digit Aadhaar numbers", () => {
      expect(isValidAadhaar("3675 9834 6125")).toBe(true);
      expect(isValidAadhaar("3675-9834-6125")).toBe(true);
      expect(isValidAadhaar("367598346125")).toBe(true);
    });

    it("rejects invalid Aadhaar numbers (starts with 0 or 1, bad checksum)", () => {
      expect(isValidAadhaar("0675 9834 6125")).toBe(false); // starts with 0
      expect(isValidAadhaar("1675 9834 6125")).toBe(false); // starts with 1
      expect(isValidAadhaar("3675 9834 6128")).toBe(false); // bad Verhoeff
    });
  });

  describe("Indian PAN Card", () => {
    it("validates standard format 5 letters + 4 digits + 1 letter with valid 4th char", () => {
      expect(isValidPanIndia("ABCDE1234F")).toBe(false); // 'D' is not in PCHABGJLFT
      expect(isValidPanIndia("ABCPE1234F")).toBe(true); // 'P' for Individual
      expect(isValidPanIndia("ABCCE1234F")).toBe(true); // 'C' for Company
      expect(isValidPanIndia("ABCHE1234F")).toBe(true); // 'H' for HUF
    });

    it("rejects invalid PAN strings", () => {
      expect(isValidPanIndia("12345ABCDE")).toBe(false);
      expect(isValidPanIndia("ABCPE12345")).toBe(false);
    });
  });

  describe("Australian TFN", () => {
    it("validates 8 and 9 digit Mod-11 TFNs", () => {
      expect(isValidAustralianTfn("64 547 386")).toBe(true);
      expect(isValidAustralianTfn("876 543 210")).toBe(true);
      expect(isValidAustralianTfn("876543210")).toBe(true);
    });

    it("rejects invalid TFN numbers", () => {
      expect(isValidAustralianTfn("876 543 211")).toBe(false);
      expect(isValidAustralianTfn("1234")).toBe(false);
    });
  });

  describe("Brazilian CPF", () => {
    it("validates 11-digit dual modulo-11 CPFs", () => {
      expect(isValidCpf("123.456.789-09")).toBe(true);
      expect(isValidCpf("12345678909")).toBe(true);
    });

    it("rejects repeated digits and invalid checksums", () => {
      expect(isValidCpf("111.111.111-11")).toBe(false);
      expect(isValidCpf("000.000.000-00")).toBe(false);
      expect(isValidCpf("123.456.789-00")).toBe(false);
    });
  });
});

describe("International Detectors - Content Scanning", () => {
  it("detects Canadian SIN with cue", () => {
    const text = "Client SIN: 130-692-908 confirmed.";
    const matches = detect(text, [...ALL_CATEGORIES]);
    const sins = matches.filter((m) => m.category === "canadian_sin");
    expect(sins).toHaveLength(1);
    expect(sins[0].value).toBe("130-692-908");
  });

  it("detects UK NHS number with cue", () => {
    const text = "Patient NHS number: 943 476 5919 registered.";
    const matches = detect(text, [...ALL_CATEGORIES]);
    const nhs = matches.filter((m) => m.category === "uk_nhs");
    expect(nhs).toHaveLength(1);
    expect(nhs[0].value).toBe("943 476 5919");
  });

  it("detects Indian Aadhaar with cue", () => {
    const text = "Resident Aadhaar: 3675 9834 6125 verified.";
    const matches = detect(text, [...ALL_CATEGORIES]);
    const aadhaar = matches.filter((m) => m.category === "aadhaar");
    expect(aadhaar).toHaveLength(1);
    expect(aadhaar[0].value).toBe("3675 9834 6125");
  });

  it("detects Indian PAN with cue", () => {
    const text = "Taxpayer PAN: ABCPE1234F on file.";
    const matches = detect(text, [...ALL_CATEGORIES]);
    const pan = matches.filter((m) => m.category === "pan_india");
    expect(pan).toHaveLength(1);
    expect(pan[0].value).toBe("ABCPE1234F");
  });

  it("detects Australian TFN with cue", () => {
    const text = "Employee Tax File Number: 876 543 210 received.";
    const matches = detect(text, [...ALL_CATEGORIES]);
    const tfn = matches.filter((m) => m.category === "australian_tfn");
    expect(tfn).toHaveLength(1);
    expect(tfn[0].value).toBe("876 543 210");
  });

  it("detects Brazilian CPF with cue", () => {
    const text = "Cadastro CPF: 123.456.789-09 aprovado.";
    const matches = detect(text, [...ALL_CATEGORIES]);
    const cpf = matches.filter((m) => m.category === "cpf");
    expect(cpf).toHaveLength(1);
    expect(cpf[0].value).toBe("123.456.789-09");
  });
});

describe("International Masking & Placeholders", () => {
  it("masks international categories correctly", () => {
    expect(maskValue("canadian_sin", "130-692-908")).toBe("***-***-908");
    expect(maskValue("uk_nhs", "943 476 5919")).toBe("***-***-5919");
    expect(maskValue("aadhaar", "3675 9834 6125")).toBe("****-****-6125");
    expect(maskValue("pan_india", "ABCPE1234F")).toBe("*****1234F");
    expect(maskValue("australian_tfn", "876 543 210")).toBe("***-***-210");
    expect(maskValue("cpf", "123.456.789-09")).toBe("***.***.***-09");
  });

  it("returns correct placeholder labels", () => {
    expect(placeholderLabelFor("canadian_sin")).toBe("SIN");
    expect(placeholderLabelFor("uk_nhs")).toBe("NHS");
    expect(placeholderLabelFor("aadhaar")).toBe("AADHAAR");
    expect(placeholderLabelFor("pan_india")).toBe("PAN");
    expect(placeholderLabelFor("australian_tfn")).toBe("TFN");
    expect(placeholderLabelFor("cpf")).toBe("CPF");
  });
});

describe("International Compliance Presets", () => {
  const internationalPresets: PresetId[] = [
    "pipeda",
    "uk_gdpr",
    "india_dpdp",
    "australia_privacy",
    "brazil_lgpd",
  ];

  it("includes all international presets in PRESET_LABELS", () => {
    for (const preset of internationalPresets) {
      expect(PRESET_LABELS[preset]).toBeDefined();
      expect(typeof PRESET_LABELS[preset]).toBe("string");
      expect(PRESET_LABELS[preset].length).toBeGreaterThan(0);
    }
  });

  it("includes relevant international categories in PRESET_CATEGORIES", () => {
    expect(PRESET_CATEGORIES.pipeda).toContain("canadian_sin");
    expect(PRESET_CATEGORIES.uk_gdpr).toContain("uk_nhs");
    expect(PRESET_CATEGORIES.india_dpdp).toContain("aadhaar");
    expect(PRESET_CATEGORIES.india_dpdp).toContain("pan_india");
    expect(PRESET_CATEGORIES.australia_privacy).toContain("australian_tfn");
    expect(PRESET_CATEGORIES.brazil_lgpd).toContain("cpf");
  });
});
