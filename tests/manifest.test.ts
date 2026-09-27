import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as {
  minimum_chrome_version: string;
  permissions: string[];
  web_accessible_resources?: unknown[];
  host_permissions?: string[];
};

describe("extension manifest disclosure contract", () => {
  it("keeps the packaged privacy page extension-origin-only", () => {
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it("uses the Chrome version required by sidePanel.open", () => {
    expect(manifest.minimum_chrome_version).toBe("116");
  });

  it("enforces zero automatic site-access permissions (no host_permissions)", () => {
    expect(manifest.host_permissions).toBeUndefined();
  });
});
