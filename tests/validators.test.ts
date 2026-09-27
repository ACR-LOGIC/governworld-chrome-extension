// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  isValidSsn,
  isValidItin,
  isValidCardExpiry,
  isValidDea,
  isValidMbi,
  luhnValid,
  isValidLuhn,
  isValidNpi,
  isNonProviderBound,
} from "../src/validators/index.js";

describe("isValidSsn", () => {
  it("accepts valid SSN shapes", () => {
    expect(isValidSsn("123-45-6789")).toBe(true);
    expect(isValidSsn("123 45 6789")).toBe(true);
    expect(isValidSsn("001234567")).toBe(true);
  });

  it("rejects structurally impossible values", () => {
    expect(isValidSsn("000-12-3456")).toBe(false); // area 000
    expect(isValidSsn("666-12-3456")).toBe(false); // area 666
    expect(isValidSsn("900-12-3456")).toBe(false); // area 900-999 never issued
    expect(isValidSsn("999-99-9999")).toBe(false);
    expect(isValidSsn("123-00-6789")).toBe(false); // group 00
    expect(isValidSsn("123-45-0000")).toBe(false); // serial 0000
    expect(isValidSsn("123456")).toBe(false); // wrong length
  });
});

describe("isValidItin", () => {
  it("accepts a valid ITIN", () => {
    expect(isValidItin("912-70-1234")).toBe(true);
    expect(isValidItin("987-98-7654")).toBe(true);
  });

  it("rejects non-9xx, invalid group, or zero serial", () => {
    expect(isValidItin("123-45-6789")).toBe(false);
    expect(isValidItin("900-00-0000")).toBe(false);
    expect(isValidItin("912-69-1234")).toBe(false); // group 69 not assigned
    expect(isValidItin("912-70-0000")).toBe(false); // serial 0000
  });
});

describe("isValidCardExpiry", () => {
  it("accepts near-future expiries", () => {
    const year = String(new Date().getFullYear() % 100).padStart(2, "0");
    expect(isValidCardExpiry(`12/${year}`)).toBe(true);
  });

  it("rejects out-of-range months and far-future years", () => {
    expect(isValidCardExpiry("13/30")).toBe(false);
    expect(isValidCardExpiry("00/30")).toBe(false);
    expect(isValidCardExpiry("01/2099")).toBe(false);
  });
});

describe("isValidDea", () => {
  it("accepts a valid DEA number", () => {
    expect(isValidDea("AB1234563")).toBe(true);
  });

  it("rejects invalid checksums and registrant letters", () => {
    expect(isValidDea("AB1234567")).toBe(false); // check digit 7 != computed 3
    expect(isValidDea("IB1234563")).toBe(false); // 'I' not a registrant code
    expect(isValidDea("AB123456")).toBe(false); // wrong length
  });
});

describe("isValidMbi", () => {
  it("accepts a valid MBI", () => {
    expect(isValidMbi("1EG4-TE5-MK73")).toBe(true);
    expect(isValidMbi("1EG4TE5MK73")).toBe(true);
  });

  it("rejects forbidden letters and wrong shapes", () => {
    expect(isValidMbi("1SG4TE5MK73")).toBe(false); // 'S' excluded
    expect(isValidMbi("1EG4TE5MK7")).toBe(false); // wrong length
    expect(isValidMbi("12345678901")).toBe(false); // all digits
  });
});

describe("Luhn / NPI", () => {
  it("luhnValid accepts valid card numbers only", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(isValidLuhn("4111111111111111")).toBe(true);
  });

  it("isValidNpi checks the 80840-prefixed Luhn", () => {
    expect(isValidNpi("1234567893")).toBe(true);
    expect(isValidNpi("1993999998")).toBe(true);
    expect(isValidNpi("1234567890")).toBe(false);
  });
});

describe("isNonProviderBound", () => {
  it("flags non-provider identifier labels", () => {
    expect(isNonProviderBound("Serial number ")).toBe(true);
    expect(isNonProviderBound("asset tag: ")).toBe(true);
    expect(isNonProviderBound("Invoice ")).toBe(true);
  });

  it("does not flag provider context", () => {
    expect(isNonProviderBound("NPI ")).toBe(false);
    expect(isNonProviderBound("Provider number ")).toBe(false);
  });
});
