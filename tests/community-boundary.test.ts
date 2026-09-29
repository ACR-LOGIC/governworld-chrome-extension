// The community boundary: what a hostile or careless peer can install into the
// detector, and what the Extension refuses to publish about a user.
//
// Community rules are detection *policy*. A rule that reaches the detector
// changes what every subsequent scan of every document reports, so the inbound
// validator is a security boundary, not a type check. The outbound screener
// exists because PRIVACY.md promises contributions are "the logic, not the data".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VALIDATOR_KEYS = [
  "isValidAadhaar",
  "isValidAustralianTfn",
  "isValidCanadianSin",
  "isValidCpf",
  "isValidCusip",
  "isValidDea",
  "isValidIsin",
  "isValidItin",
  "isValidLoinc",
  "isValidMbi",
  "isValidNhsNumber",
  "isValidNpi",
  "isValidPanIndia",
  "isValidSedol",
  "isValidSsn",
  "luhnValid",
] as const;

vi.mock("../src/validators/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/validators/index.js")>();
  const stub: Record<string, unknown> = { ...actual };
  for (const key of VALIDATOR_KEYS) {
    if (key === "luhnValid") continue;
    stub[key] = vi.fn(() => false);
  }
  return stub;
});

const validators = await import("../src/validators/index.js");
const { fetchCommunityRules, screenContributionPayload, isValidCommunityRule } = await import(
  "../src/shared/customPatterns.js"
);

/** A structurally sound rule; tests mutate exactly one field at a time. */
function rule(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: "rule_abc123",
    name: "Internal Ticket Reference",
    category: "custom",
    pattern: "TKT-\\d{6}",
    flags: "gi",
    confidence: 0.8,
    totalVotes: 12,
    upvotes: 12,
    downvotes: 0,
    verificationStatus: "approved",
    createdByHandle: "contributor42",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const ok = (r: unknown) => isValidCommunityRule(r);

describe("community rule inbound validation", () => {
  it("accepts a well-formed rule", () => {
    expect(ok(rule())).toBe(true);
  });

  it("rejects an unknown category", () => {
    // The detector routes findings by category, so a typo'd value would not
    // throw - it would silently drop the finding from the report.
    expect(ok(rule({ category: "not-a-category" }))).toBe(false);
    expect(ok(rule({ category: 42 }))).toBe(false);
    expect(ok(rule({ category: undefined }))).toBe(false);
  });

  it("accepts a real finding category as well as 'custom'", () => {
    expect(ok(rule({ category: "custom" }))).toBe(true);
  });

  it("rejects flag combinations the local wizard would never produce", () => {
    // Sticky 'y' ties a match to the previous match's end position, so a rule
    // authored against one string can silently match nothing in the next scan.
    expect(ok(rule({ flags: "y" }))).toBe(false);
    expect(ok(rule({ flags: "gy" }))).toBe(false);
    expect(ok(rule({ flags: "d" }))).toBe(false);
    expect(ok(rule({ flags: "" }))).toBe(true);
  });

  it("rejects a catastrophic-backtracking pattern", () => {
    expect(ok(rule({ pattern: "(a+)+$" }))).toBe(false);
    expect(ok(rule({ pattern: "(a|a?)+$" }))).toBe(false);
  });

  it("rejects out-of-range and non-finite numbers", () => {
    expect(ok(rule({ confidence: 1.5 }))).toBe(false);
    expect(ok(rule({ confidence: -0.1 }))).toBe(false);
    expect(ok(rule({ confidence: Number.NaN }))).toBe(false);
    expect(ok(rule({ confidence: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(ok(rule({ totalVotes: -1 }))).toBe(false);
    expect(ok(rule({ upvotes: 2_000_000 }))).toBe(false);
  });

  it("rejects oversized and malformed identifiers", () => {
    expect(ok(rule({ ruleId: "has space" }))).toBe(false);
    expect(ok(rule({ ruleId: "x".repeat(65) }))).toBe(false);
    expect(ok(rule({ name: "" }))).toBe(false);
    expect(ok(rule({ name: "x".repeat(121) }))).toBe(false);
    expect(ok(rule({ pattern: "a".repeat(501) }))).toBe(false);
    expect(ok(rule({ createdAt: "not-a-date" }))).toBe(false);
  });

  it("rejects non-objects outright", () => {
    for (const bad of [null, undefined, "rule", 42, [], true]) {
      expect(ok(bad)).toBe(false);
    }
  });
});

describe("fetchCommunityRules", () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const respondWith = (body: unknown, ok = true) =>
    fetchMock.mockResolvedValue({ ok, json: async () => body });

  it("keeps valid rules and drops malformed ones without failing the pack", async () => {
    respondWith({
      rules: [
        rule({ ruleId: "keep_1" }),
        rule({ ruleId: "drop_1", pattern: "(a+)+$" }),
        rule({ ruleId: "keep_2", category: "nonsense" }),
        "not a rule",
        null,
      ],
    });
    const out = await fetchCommunityRules();
    expect(out.map((r) => r.ruleId)).toEqual(["keep_1"]);
  });

  it("returns an empty list instead of throwing on a hostile response shape", async () => {
    for (const body of [null, {}, { rules: "nope" }, { rules: null }, [], 42]) {
      respondWith(body);
      await expect(fetchCommunityRules()).resolves.toEqual([]);
    }
  });

  it("returns an empty list on HTTP error and on network failure", async () => {
    respondWith({ rules: [rule()] }, false);
    await expect(fetchCommunityRules()).resolves.toEqual([]);

    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(fetchCommunityRules()).resolves.toEqual([]);
  });

  it("caps the pack size", async () => {
    respondWith({ rules: Array.from({ length: 900 }, (_, i) => rule({ ruleId: `r${i}` })) });
    expect((await fetchCommunityRules()).length).toBe(500);
  });

  it("only ever requests the community host, with no credentials", async () => {
    respondWith({ rules: [] });
    await fetchCommunityRules();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://community.governworld.acrlogic.com/v1/community/rules");
    // No cookies, auth, or gateway key may ride along with a rule fetch.
    expect(init.credentials ?? "omit").toBe("omit");
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization|cookie|api-key/i);
  });
});

describe("contribution screening", () => {
  const pattern = (overrides: Record<string, unknown> = {}) => ({
    id: "p1",
    name: "Internal Ticket Reference",
    category: "custom",
    pattern: "TKT-\\d{6}",
    flags: "gi",
    captureGroup: 0,
    confidence: 0.8,
    createdAt: "2026-09-01T00:00:00.000Z",
    source: "wizard",
    ...overrides,
  });

  it("passes a genuine rule through untouched", () => {
    const r = screenContributionPayload(pattern() as never);
    expect(r.safe).toBe(true);
  });

  it("does not block rules whose digits are structure rather than data", () => {
    // A detection rule legitimately contains quantifiers and character classes.
    // A screener that rejected these would make real rules unsubmittable.
    for (const p of ["\\d{3}-\\d{2}-\\d{4}", "[0-9]{10}", "AB-\\d{4}", "\\d{6,19}", "(?:x)\\d{2}"]) {
      const r = screenContributionPayload(pattern({ pattern: p }) as never);
      expect(r.safe, `blocked structural pattern ${p}`).toBe(true);
    }
  });

  it("blocks a literal SSN pasted into the pattern", () => {
    vi.mocked(validators.isValidSsn).mockReturnValueOnce(true);
    const r = screenContributionPayload(pattern({ pattern: "SSN:\\s*(219-09-9999)" }) as never);
    expect(r.safe).toBe(false);
    if (!r.safe) {
      expect(r.field).toBe("pattern");
      expect(r.kind).toMatch(/identifier/i);
    }
  });

  it("blocks a literal email address in a context cue", () => {
    const r = screenContributionPayload(
      pattern({ contextCues: ["contact ops@realcompany.com first"] }) as never,
    );
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.field).toBe("contextCue");
  });

  it("blocks a literal email address in the rule name", () => {
    const r = screenContributionPayload(pattern({ name: "rule for jane.doe@realco.com" }) as never);
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.field).toBe("name");
  });

  it("blocks a literal payment card number", () => {
    const r = screenContributionPayload(pattern({ pattern: "4111111111111111" }) as never);
    expect(r.safe).toBe(false);
  });

  it("blocks a literal DEA registration number", () => {
    vi.mocked(validators.isValidDea).mockReturnValueOnce(true);
    const r = screenContributionPayload(pattern({ pattern: "dea AB1234567" }) as never);
    expect(r.safe).toBe(false);
  });

  it("never echoes the offending value back to the caller", () => {
    // A rejection message is shown in the UI and may be logged, so it must not
    // become a path that copies the data the screener just caught.
    vi.mocked(validators.isValidSsn).mockReturnValueOnce(true);
    const r = screenContributionPayload(pattern({ pattern: "219-09-9999" }) as never);
    expect(r.safe).toBe(false);
    expect(JSON.stringify(r)).not.toContain("219-09-9999");
  });

  it("strips identity and timestamp from an accepted payload", () => {
    const r = screenContributionPayload(pattern() as never);
    expect(r.safe).toBe(true);
    if (!r.safe) return;
    const serialized = JSON.stringify(r.payload);
    expect(serialized).not.toMatch(/"id"|"createdAt"|"source"/);
  });
});
