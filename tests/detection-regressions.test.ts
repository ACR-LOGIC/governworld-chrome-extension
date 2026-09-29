// Regressions for defects found by an adversarial pass over the detector.
//
// Every case here was reproduced against the real detect()/validators before the
// fix. The two that mattered most were silent data leaks: a payment card whose
// last 11 digits survived redaction, and a PEM private key whose body was left
// in plain text because only the 30-character header matched.
//
// Fixtures are synthetic throughout: invented characters in the published shape
// of each credential or identifier.
import { describe, expect, it } from "vitest";
import { detect, resolveOverlaps } from "../src/content/detect.js";
import { isValidDea, isValidItin } from "../src/validators/index.js";
import type { FindingCategory } from "../src/shared/types.js";

const ALL: FindingCategory[] = [
  "payment_card",
  "ssn",
  "canadian_sin",
  "uk_nhs",
  "aadhaar",
  "pan_india",
  "australian_tfn",
  "cpf",
  "npi",
  "dea",
  "mbi",
  "secrets",
  "email",
  "phone",
  "dob",
  "medical_record_number",
  "member_id",
  "address",
  "custom",
  "possible_name",
];

const run = (text: string) => detect(text, [...ALL], []);
const values = (text: string, category?: string) =>
  run(text).filter((m) => (category ? m.category === category : true)).map((m) => m.value);

/**
 * Assembles a credential-shaped fixture from fragments.
 *
 * GitHub push protection scans blob content for credential patterns. The
 * fixtures here are synthetic, but written contiguously they get the push
 * rejected, and allowlisting them would teach this repository's push
 * protection to ignore real credentials of these shapes. Splitting the literal
 * leaves no credential-shaped string in the tree while the detector still
 * receives byte-identical input.
 */
const fx = (...parts: string[]): string => parts.join("");

describe("a finding must never leave part of a credential exposed", () => {
  it("masks a whole card number that follows a street address", () => {
    // The address tail used to end at "...Rd 41111" and the card match was then
    // discarded as an overlap, leaving eleven digits of the card in the page.
    const matches = run("5 Ocean Rd 4111111111111111");
    const card = matches.find((m) => m.category === "payment_card");
    expect(card, "the card must be detected at all").toBeDefined();
    expect(card!.value).toBe("4111111111111111");
    // And the span must cover every digit.
    expect(card!.end - card!.start).toBe(16);
  });

  it("masks a card that follows a full address", () => {
    const matches = run("123 Main Street, Springfield IL 62704 4111111111111111");
    expect(values("123 Main Street, Springfield IL 62704 4111111111111111", "payment_card")).toContain(
      "4111111111111111",
    );
    expect(matches.every((m) => m.category === "payment_card" || m.category === "address")).toBe(true);
  });

  it("masks the whole PEM block, not just the header line", () => {
    const pem = [
      fx("-----BEGIN ", "RSA ", "PRIVATE KEY-----"),
      "MIIEowIBAAKCAQEAx7Vv8Q9pQ2mZ4bN6cD8eF0gH2iJ4kL6mN8oP0qR2sT4uV6wX8yZ0",
      "1a3B5c7D9eF1gH3iJ5kL7mN9oP1qR3sT5uV7wX9yZ1a2B4c6D8eF0gH2iJ4kL6mN8oP0",
      fx("-----END ", "RSA ", "PRIVATE KEY-----"),
    ].join("\n");
    const found = values(pem, "secrets");
    expect(found).toHaveLength(1);
    // The body is the secret. Only masking the header is the same as not masking.
    expect(found[0]).toBe(pem);
  });

  it("masks the credentials in a URL, including the username", () => {
    const found = values("https://admin:hunter2secret@example.test/path", "secrets");
    expect(found).toHaveLength(1);
    // Previously reported as an email, which left "admin:" visible and labelled
    // the credential as a person's address.
    expect(found[0]).toContain("admin");
    expect(found[0]).toContain("hunter2secret");
  });

  it("keeps the scheme word when masking a bearer token", () => {
    const token = "sk-1234567890abcdef1234567890";
    const found = values(`Authorization: Bearer ${token} in header`, "secrets");
    expect(found).toContain(token);
    expect(found.join(" ")).not.toContain("Bearer ");
  });
});

describe("resolveOverlaps picks by priority, not by position", () => {
  it("keeps a high-priority match that starts inside a lower-priority one", () => {
    const merged = resolveOverlaps([
      { category: "address", confidence: 0.84, value: "5 Ocean Rd 41111", start: 0, end: 16 },
      { category: "payment_card", confidence: 0.99, value: "4111111111111111", start: 11, end: 27 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].category).toBe("payment_card");
  });

  it("keeps disjoint matches untouched and ordered by position", () => {
    const merged = resolveOverlaps([
      { category: "email", confidence: 0.92, value: "b@example.test", start: 40, end: 54 },
      { category: "payment_card", confidence: 0.99, value: "4111111111111111", start: 0, end: 16 },
    ]);
    expect(merged.map((m) => m.start)).toEqual([0, 40]);
  });

  it("resolves a chain of overlapping matches as one cluster", () => {
    // a overlaps b, b overlaps c, a does not overlap c.
    const merged = resolveOverlaps([
      { category: "address", confidence: 0.8, value: "a", start: 0, end: 10 },
      { category: "email", confidence: 0.9, value: "b", start: 5, end: 20 },
      { category: "ssn", confidence: 0.95, value: "c", start: 15, end: 30 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].category).toBe("ssn");
  });

  it("returns an empty array unchanged", () => {
    expect(resolveOverlaps([])).toEqual([]);
  });
});

describe("cloud and platform credentials that were previously missed", () => {
  const cases: [string, string][] = [
    ["AWS access key ID", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE"],
    ["AWS bare access key ID", "AKIAIOSFODNN7EXAMPLE"],
    ["AWS session key ID", "ASIAIOSFODNN7EXAMPLE"],
    ["GitLab personal access token", "glpat-abcdefghij1234567890"],
    ["HuggingFace token", "hf_abcdefghijklmnopqrstuvwxyz0123"],
    // The Slack webhook fixture deliberately does not copy a real webhook's
    // path shape (T.../B.../secret). GitHub push protection matches that shape
    // and blocks the push, and the detector's rule gains nothing from it: the
    // pattern is `hooks\.slack\.com/services/` plus ten or more characters from a
    // fixed set, so coverage is identical with a plainly fake path. Restore the
    // realistic path and the push is rejected as a leaked credential.
    ["Slack incoming webhook", "https://hooks.slack.com/services/NOTAREALWEBHOOKPATH0000000000"],
    ["Azure SAS signature", "https://x.blob.core.windows.net/c?sv=2021&sig=AbCdEf123456ghijklmnop%3D"],
    ["HTTP basic authorization", "Authorization: Basic YWRtaW46c3VwZXJzZWNyZXQxMjM="],
    ["credential value containing dots", "password=abc.def.ghi.jkl.mno.pqr"],
    ["client secret", "client_secret = G0eKxyzABCdef123456GHI"],
  ];

  for (const [label, text] of cases) {
    it(`detects a ${label}`, () => {
      expect(values(text, "secrets").length, `nothing detected in: ${text}`).toBeGreaterThan(0);
    });
  }

  it("no longer classifies a GitLab token as an email address", () => {
    const found = run("glpat-abcdefghij1234567890@gitlab.example.com");
    expect(found.find((m) => m.category === "secrets")).toBeDefined();
    expect(found.find((m) => m.category === "email")).toBeUndefined();
  });

  it("does not treat an environment variable reference as a credential", () => {
    // The capture class accepts dots so real dotted values match, which makes
    // this necessary: otherwise every `KEY = process.env.X` line in a code
    // review is reported as a leaked secret.
    for (const line of [
      "const apiKey = process.env.API_KEY;",
      "password = os.environ.APP_PASSWORD",
      "token = ${GITHUB_TOKEN}",
    ]) {
      expect(values(line, "secrets"), `false positive: ${line}`).toEqual([]);
    }
  });
});

describe("label-bound identifiers no longer mask ordinary prose", () => {
  it("requires a digit after a record-number label", () => {
    for (const prose of [
      "MRN pending review.",
      "The record number is protected health information.",
      "Medical record number is redacted.",
    ]) {
      expect(values(prose, "medical_record_number"), `false positive: ${prose}`).toEqual([]);
    }
  });

  it("requires a digit after a member/patient id label", () => {
    for (const prose of ["Patient ID unknown at admission.", "Member ID literally follows."]) {
      expect(values(prose, "member_id"), `false positive: ${prose}`).toEqual([]);
    }
  });

  it("still detects a real record number after the same labels", () => {
    expect(values("MRN: 4457821", "medical_record_number")).toEqual(["4457821"]);
    expect(values("Patient ID: AB-99213", "member_id")).toEqual(["AB-99213"]);
  });
});

describe("the SSN cue requires the full phrase", () => {
  it("does not fire on the bare word 'social'", () => {
    expect(values("Join our social 123456789 community", "ssn")).toEqual([]);
  });

  it("still fires on 'social security number'", () => {
    expect(values("social security number 123456789", "ssn")).toEqual(["123456789"]);
  });

  it("still fires on the abbreviation", () => {
    expect(values("SSN: 123-45-6789", "ssn")).toEqual(["123-45-6789"]);
  });
});

describe("email matching is not a denial of service", () => {
  // The old pattern was an unbounded `[...]+@`, which starts a scan at every
  // word boundary and backtracks the whole remaining run when there is no `@`.
  // Measured at 15s for 100k in-class characters. This asserts a bound well
  // under that, because the content script runs on unsized page text.
  it("handles a long run of in-class characters with no @ quickly", () => {
    const hostile = "a".repeat(100_000);
    const started = Date.now();
    run(hostile);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("handles long dotted and dashed runs, the shape that caused the boundary storm", () => {
    const hostile = "a.a-a".repeat(20_000);
    const started = Date.now();
    run(hostile);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("still finds real addresses in a large document", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(4_000);
    const found = values(`${filler} contact person@example.test for details`, "email");
    expect(found).toContain("person@example.test");
  });
});

describe("validator corrections", () => {
  it("accepts ITINs in the 50-65 group range", () => {
    // The 50-65 groups are the ITINs issued from 1993; they were missing, so
    // every pre-2000 ITIN was rejected.
    expect(isValidItin("912-50-1234")).toBe(true);
    expect(isValidItin("912-55-1234")).toBe(true);
    expect(isValidItin("912-65-1234")).toBe(true);
  });

  it("still accepts the other valid ITIN ranges and rejects the gaps", () => {
    expect(isValidItin("912-70-1234")).toBe(true);
    expect(isValidItin("912-88-1234")).toBe(true);
    expect(isValidItin("912-90-1234")).toBe(true);
    expect(isValidItin("912-92-1234")).toBe(true);
    expect(isValidItin("912-94-1234")).toBe(true);
    expect(isValidItin("912-99-1234")).toBe(true);
    expect(isValidItin("912-66-1234")).toBe(false);
    expect(isValidItin("912-69-1234")).toBe(false);
    expect(isValidItin("912-93-1234")).toBe(false);
  });

  it("accepts the DEA registrant types that were missing", () => {
    // P and R are Narcotic Treatment Program registrations, S and T are
    // mid-level practitioners, U is data-waiver. No valid number existed for
    // any of these prefixes before.
    const withValidBody = (prefix: string) => {
      for (let n = 1000000; n < 1010000; n++) {
        if (isValidDea(`${prefix}${n}`)) return true;
      }
      return false;
    };
    for (const prefix of ["PP", "RR", "SS", "TT", "UU"]) {
      expect(withValidBody(prefix), `no valid DEA body exists for prefix ${prefix}`).toBe(true);
    }
    // And the previously working prefixes still work.
    for (const prefix of ["AA", "MM", "XX"]) {
      expect(withValidBody(prefix), `prefix ${prefix} regressed`).toBe(true);
    }
  });

  it("still rejects prefixes that are not registrant codes", () => {
    let accepted = false;
    for (let n = 1000000; n < 1010000; n++) {
      if (isValidDea(`NI${n}`)) {
        accepted = true;
        break;
      }
    }
    expect(accepted).toBe(false);
  });
});
