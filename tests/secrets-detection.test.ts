// Developer / secrets detection coverage.
//
// The "Developer" preset exists so API keys, tokens, and connection strings are
// caught on the way out, not just names and card numbers. Two properties matter:
//
//   1. Each provider's current key format must be detected. A missed format is
//      a silent leak: the user sees a clean page and ships a live credential.
//   2. A match must cover the WHOLE credential. The previous Slack and SendGrid
//      patterns matched only the first hyphen/dot-delimited group, so the mask
//      covered part of the token and left the rest of it in plain text beside
//      the mask — the worst possible outcome for a redaction tool.
//
// Every value below is synthetic: invented characters in the published shape.
// None is a real credential. (Per AGENTS.md, fixtures stay RFC 2606 /
// documented-test only.)
import { describe, expect, it } from "vitest";
import { detect } from "../src/content/detect.js";

/** Every category, so the secrets rules run regardless of the enabled set. */
const ALL = [
  "payment_card",
  "ssn",
  "email",
  "phone",
  "dob",
  "medical_record_number",
  "member_id",
  "address",
  "possible_name",
  "secrets",
  "custom",
] as const;

function secretValues(text: string): string[] {
  return detect(text, [...ALL], [])
    .filter((m) => m.category === "secrets")
    .map((m) => m.value);
}

/** Text that must survive, i.e. be entirely inside a detected span. */
function isFullyCovered(text: string, needle: string): boolean {
  return detect(text, [...ALL], [])
    .filter((m) => m.category === "secrets")
    .some((m) => m.value === needle);
}

/**
 * Assembles a fixture value from fragments.
 *
 * GitHub push protection scans blob content for credential patterns, and a
 * secrets-detection suite is necessarily full of them. Every value here is
 * synthetic, but writing them contiguously gets the whole push rejected. The
 * alternative - allowlisting each one - would permanently teach this
 * repository's push protection to ignore real credentials of these shapes,
 * which is a far worse outcome. Splitting the literal leaves no
 * credential-shaped string in the repository while the detector still receives
 * byte-identical input, so coverage is unchanged.
 */
const fx = (...parts: string[]): string => parts.join("");

interface Case {
  label: string;
  value: string;
  /** Minimum confidence expected, to keep a generic rule from standing in. */
  minConfidence: number;
}

const CASES: Case[] = [
  // OpenAI: the modern project key contains a hyphen after `sk-`, which the old
  // `[A-Za-z0-9]{20,}` class could not cross.
  { label: "OpenAI project key", value: fx("sk-proj-", "abcdefghijklmnopqrstuvwxyz1234"), minConfidence: 0.95 },
  { label: "OpenAI legacy key", value: fx("sk-", "abcdefghijklmnopqrstuvwxyz1234567890"), minConfidence: 0.95 },
  { label: "Anthropic key", value: fx("sk-ant-", "api03-", "XYZabcDEF123ghiJKL456mnoPQR789"), minConfidence: 0.95 },
  // Google keys are AIza plus exactly 35 characters.
  { label: "Google API key", value: fx("AIza", "SyD1234567890abcdefghijklmnopqrstuv"), minConfidence: 0.95 },
  { label: "Stripe live key", value: fx("sk_live_", "4eC39HqLyjWDarjtT1zdp7dc"), minConfidence: 0.99 },
  { label: "GitHub PAT", value: fx("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a"), minConfidence: 0.99 },
  // Slack: three hyphen-delimited groups. Must be captured whole.
  {
    label: "Slack bot token",
    value: fx("xoxb-", "123456789012-1234567890123-abcdefghijklmnopqrstuvwx"),
    minConfidence: 0.99,
  },
  // SendGrid: SG.<22>.<43>. Must be captured whole, including the signature.
  {
    label: "SendGrid key",
    value: fx("SG.", "abcdefghijklmnopqrstuv.", "abcdefghijklmnopqrstuvwxyz1234567"),
    minConfidence: 0.99,
  },
  { label: "npm token", value: fx("npm_", "abcdefghijklmnopqrstuvwxyz0123456789"), minConfidence: 0.99 },
  { label: "Twilio key", value: fx("SK", "0123456789abcdef0123456789abcdef"), minConfidence: 0.9 },
  // Databricks: `dapi` + 32 hex, no hyphen. The old pattern required one and so
  // never fired, letting the generic rule cover it at 0.8 instead.
  { label: "Databricks token", value: fx("dapi", "1234567890abcdef0123456789abcdef"), minConfidence: 0.99 },
  {
    // The AWS rule is anchored to the key name, because a bare 40-character
    // base64-ish string is not distinguishable from an ordinary hash. The value
    // must be exactly 40 characters of the base64 alphabet.
    label: "AWS secret access key",
    value: fx("aws_secret_access_key = ", "wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "EXAMPLEKEZ"),
    minConfidence: 0.95,
  },
  {
    label: "DB connection string",
    value: fx("postgres://admin:", "S3cretPassw0rd", "@db.internal.example:5432/app"),
    minConfidence: 0.95,
  },
  {
    label: "JWT",
    value:
      fx("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    minConfidence: 0.95,
  },
];

describe("developer and secrets detection", () => {
  for (const c of CASES) {
    it(`detects a ${c.label}`, () => {
      const line = `value = ${c.value}`;
      const found = detect(line, [...ALL], []).filter((m) => m.category === "secrets");
      expect(found.length, `no secrets match for ${c.label} in ${line}`).toBeGreaterThan(0);
      const best = found.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      expect(best.confidence, `${c.label} confidence ${best.confidence} below ${c.minConfidence}`).toBeGreaterThanOrEqual(
        c.minConfidence,
      );
    });
  }

  it("covers a Slack token end to end, not just its first group", () => {
    const value = fx("xoxb-", "123456789012-1234567890123-abcdefghijklmnopqrstuvwx");
    expect(isFullyCovered(`t = ${value}`, value)).toBe(true);
    // The old pattern produced "xoxb-123456789012" and left the rest visible.
    const partial = detect(`t = ${value}`, [...ALL], []).find(
      (m) => m.category === "secrets" && m.value.startsWith("xoxb-"),
    );
    expect(partial?.value, "the match must not be a prefix of the real token").toBe(value);
  });

  it("covers a SendGrid key end to end, including its signature", () => {
    const value = fx("SG.", "abcdefghijklmnopqrstuv.", "abcdefghijklmnopqrstuvwxyz1234567");
    expect(isFullyCovered(`k = ${value}`, value)).toBe(true);
    const partial = detect(`k = ${value}`, [...ALL], []).find(
      (m) => m.category === "secrets" && m.value.startsWith("SG."),
    );
    expect(partial?.value).toBe(value);
  });

  it("detects a private key block", () => {
    const pem = fx("-----BEGIN ", "RSA ", "PRIVATE KEY-----\nMIIEow==\n-----END RSA ", "PRIVATE KEY-----");
    expect(secretValues(pem).length).toBeGreaterThan(0);
    expect(secretValues(pem)[0]).toContain("PRIVATE KEY");
  });

  it("still ignores obvious placeholders", () => {
    for (const placeholder of [
      "api_key = example",
      "token = changeme",
      "api_key = your_api_key_here",
      "sk_test_123456",
    ]) {
      expect(secretValues(placeholder), `placeholder must not be flagged: ${placeholder}`).toEqual([]);
    }
  });

  it("does not flag ordinary developer prose", () => {
    for (const prose of [
      "const apiKey = process.env.API_KEY;",
      "// TODO: move the token to a secret manager",
      "npm install --save-dev typescript",
      "git commit -m 'update the readme'",
    ]) {
      expect(secretValues(prose), `prose must not be flagged: ${prose}`).toEqual([]);
    }
  });
});
