// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  canonicalizePolicyRules,
  computeSha256Hex,
  verifyPolicyIntegrity,
  syncPolicy,
} from "../src/api/policies.js";
import { GovernWorldApiClient } from "../src/api/client.js";
import type { PolicyPackage } from "../src/api/types.js";

describe("Policy Synchronization & Cryptographic Integrity", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies matching SHA-256 cryptographic hash for valid policy packages", async () => {
    const rules = [
      {
        id: "rule_custom_1",
        category: "ssn",
        pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
        cues: ["ssn", "social"],
        confidence: 0.95,
        description: "Standard US SSN",
      },
      {
        id: "rule_custom_2",
        category: "payment_card",
        pattern: "\\b\\d{16}\\b",
        confidence: 0.9,
        description: "16-digit card",
      },
    ];

    const canonical = canonicalizePolicyRules(rules);
    const expectedHash = await computeSha256Hex(canonical);

    const validPackage: PolicyPackage = {
      policy_id: "pol_acme_v1",
      policy_version: "1.0.0",
      effective_at: "2026-01-01T00:00:00Z",
      expires_at: "2027-01-01T00:00:00Z",
      policy_hash: expectedHash,
      rules,
    };

    const verification = await verifyPolicyIntegrity(validPackage);
    expect(verification.valid).toBe(true);
  });

  it("detects tampering and rejects policy when any rule pattern or cue is modified", async () => {
    const rules = [
      {
        id: "rule_tamper",
        category: "ssn",
        pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
        confidence: 0.95,
      },
    ];

    const canonical = canonicalizePolicyRules(rules);
    const legitimateHash = await computeSha256Hex(canonical);

    // Tamper with regex pattern
    const tamperedPackage: PolicyPackage = {
      policy_id: "pol_tampered",
      policy_version: "1.0.0",
      effective_at: "2026-01-01T00:00:00Z",
      policy_hash: legitimateHash,
      rules: [
        {
          id: "rule_tamper",
          category: "ssn",
          pattern: ".*", // Tampered wildcard!
          confidence: 0.95,
        },
      ],
    };

    const verification = await verifyPolicyIntegrity(tamperedPackage);
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain("Integrity check failed");
  });

  it("fails closed when policy payload is expired", async () => {
    const rules = [
      {
        id: "rule_expired",
        category: "email",
        pattern: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b",
        confidence: 0.9,
      },
    ];

    const canonical = canonicalizePolicyRules(rules);
    const hash = await computeSha256Hex(canonical);

    const expiredPackage: PolicyPackage = {
      policy_id: "pol_expired",
      policy_version: "1.0.0",
      effective_at: "2020-01-01T00:00:00Z",
      expires_at: "2020-12-31T23:59:59Z", // Expired years ago
      policy_hash: hash,
      rules,
    };

    const verification = await verifyPolicyIntegrity(expiredPackage);
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain("Policy expired");
  });

  it("refuses to activate corrupted policy payload during synchronization", async () => {
    const corruptedPayload: PolicyPackage = {
      policy_id: "pol_corrupted",
      policy_version: "2.0.0",
      effective_at: "2026-01-01T00:00:00Z",
      policy_hash: "0000000000000000000000000000000000000000000000000000000000000000",
      rules: [
        {
          id: "rule_corrupt",
          category: "secrets",
          pattern: "sk-[A-Za-z0-9]{32}",
          confidence: 0.99,
        },
      ],
    };

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(corruptedPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await syncPolicy(client, "mock_token");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Policy activation rejected");
    }
  });
});
