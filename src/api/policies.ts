// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Policy synchronization and cryptographic integrity verification.
 * Protects policy payloads with SHA-256 hash verification before activation.
 * Corrupted or expired policy payloads are rejected immediately (fail-closed).
 */

import { GovernWorldApiClient } from "./client.js";
import type { PolicyPackage, PolicyRule } from "./types.js";

const STORAGE_KEY_CACHED_POLICY = "gw_cached_policy";

/**
 * Canonicalizes a policy's rules into a deterministic JSON string for hashing.
 */
export function canonicalizePolicyRules(rules: PolicyRule[]): string {
  // Sort rules by id to ensure order-independence
  const sorted = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(
    sorted.map((r) => ({
      category: r.category,
      confidence: r.confidence,
      cues: r.cues ? [...r.cues].sort() : undefined,
      description: r.description,
      id: r.id,
      pattern: r.pattern,
    }))
  );
}

/**
 * Computes the SHA-256 hex digest of a string using Web Crypto API.
 */
export async function computeSha256Hex(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validates the cryptographic hash and expiration of a policy package.
 */
export async function verifyPolicyIntegrity(
  pkg: PolicyPackage,
  nowMs = Date.now()
): Promise<{ valid: boolean; reason?: string }> {
  if (!pkg || !pkg.policy_id || !pkg.policy_version || !pkg.policy_hash || !Array.isArray(pkg.rules)) {
    return { valid: false, reason: "Malformed policy structure." };
  }

  // Check expiration if provided
  if (pkg.expires_at) {
    const expiresMs = new Date(pkg.expires_at).getTime();
    if (!isNaN(expiresMs) && nowMs > expiresMs) {
      return { valid: false, reason: `Policy expired at ${pkg.expires_at}.` };
    }
  }

  // Compute and compare hash
  const canonical = canonicalizePolicyRules(pkg.rules);
  const computedHash = await computeSha256Hex(canonical);

  if (computedHash.toLowerCase() !== pkg.policy_hash.toLowerCase()) {
    return {
      valid: false,
      reason: `Integrity check failed: Computed hash (${computedHash}) does not match declared hash (${pkg.policy_hash}).`,
    };
  }

  return { valid: true };
}

/**
 * Synchronizes the organization's policy from GovernWorld API and verifies cryptographic integrity.
 */
export async function syncPolicy(
  client: GovernWorldApiClient,
  token?: string,
  currentVersion?: string
): Promise<{ ok: true; policy: PolicyPackage } | { ok: false; error: string }> {
  const query = currentVersion ? `?current_version=${encodeURIComponent(currentVersion)}` : "";
  const result = await client.get<PolicyPackage>(`/api/v1/extension/policy${query}`, { token });

  if (!result.ok) {
    return { ok: false, error: result.error.user_message };
  }

  const pkg = result.data;
  const verification = await verifyPolicyIntegrity(pkg);

  if (!verification.valid) {
    return {
      ok: false,
      error: `Policy activation rejected: ${verification.reason}`,
    };
  }

  // Save verified policy to local cache
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY_CACHED_POLICY]: pkg });
  }

  return { ok: true, policy: pkg };
}

/**
 * Retrieves the currently active, verified policy from local cache.
 */
export async function getCachedPolicy(): Promise<PolicyPackage | null> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    const res = await chrome.storage.local.get(STORAGE_KEY_CACHED_POLICY);
    const cached = res[STORAGE_KEY_CACHED_POLICY] as PolicyPackage | undefined;
    if (cached) {
      const check = await verifyPolicyIntegrity(cached);
      if (check.valid) return cached;
    }
  }
  return null;
}
