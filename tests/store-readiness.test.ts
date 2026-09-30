// Store-submission consistency: the manifest is the source of truth, and the
// documents a reviewer reads must agree with it.
//
// The Chrome Web Store asks a reviewer to check that every declared permission
// is justified and disclosed. That justification lives in prose in three
// documents (PERMISSIONS.md, STORE_DESCRIPTION.md, CHROMEWEBSTORE.md), which are
// not type-checked and drift silently: contextMenus was added to the manifest and
// implemented in the service worker, but appeared in none of them, while
// PERMISSIONS.md still claimed to map "every permission in manifest.json".
//
// Link currency is the same class of bug. The repository was renamed from
// `governworld` to `governworld-extension`, and 14 references across four files
// kept pointing at the old name — nine of which 404.
//
// These assertions read the manifest and fail when the documents fall behind.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(extRoot, rel), "utf8");

const manifest = JSON.parse(read("manifest.json"));
const declared = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])].sort();
const hostPermissions = [
  ...(manifest.host_permissions ?? []),
  ...(manifest.optional_host_permissions ?? []),
];

const PERMISSION_DOCS = ["PERMISSIONS.md", "STORE_DESCRIPTION.md", "CHROMEWEBSTORE.md"];

describe("manifest permission declarations", () => {
  it("requests no automatic host permissions; site access is runtime-only", () => {
    // Zero-egress posture, updated for always-on: no install-time site
    // access of any kind. The only page access is optional http(s) origins
    // the user grants at runtime (and can revoke), so default installs still
    // touch no website automatically.
    expect(manifest.host_permissions, "dist must keep its zero-egress posture").toBeUndefined();
    expect(manifest.optional_host_permissions?.slice().sort()).toEqual(["http://*/*", "https://*/*"]);
    expect(hostPermissions.slice().sort()).toEqual(["http://*/*", "https://*/*"]);
  });

  it("does not request the blanket permissions a local-first tool should never need", () => {
    for (const banned of ["tabs", "webRequest", "webRequestBlocking", "cookies", "history", "bookmarks", "clipboardRead", "<all_urls>"]) {
      expect(declared, `${banned} must not be requested`).not.toContain(banned);
    }
  });

  it("keeps the service worker as the only background context", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background?.service_worker).toBeTruthy();
  });

  it("restricts extension pages to self and wasm-unsafe-eval, with no remote origin", () => {
    const csp = manifest.content_security_policy?.extension_pages ?? "";
    expect(csp).toContain("script-src 'self'");
    // Tesseract/pdf.js need WebAssembly compilation, not eval of page strings.
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/https?:\/\//);
    expect(csp).not.toMatch(/'unsafe-eval'/);
  });
});

describe("every declared permission is justified and disclosed", () => {
  // A permission missing from the reviewer's justification is a rejection risk,
  // not a documentation nit.
  for (const perm of declared) {
    it(`\`${perm}\` appears in ${PERMISSION_DOCS.join(", ")}`, () => {
      for (const doc of PERMISSION_DOCS) {
        expect(read(doc), `${doc} must justify \`${perm}\``).toContain(`\`${perm}\``);
      }
    });
  }

  it("PERMISSIONS.md does not document a permission the manifest does not declare", () => {
    const doc = read("PERMISSIONS.md");
    // Only scan the "Requested permissions" table. The same file has a second
    // table headed "Permissions the extension deliberately does NOT request",
    // whose column-1 entries are the point: they must NOT be in the manifest.
    const section = doc.split(/^##\s+Optional permissions/im)[0] ?? doc;
    const justified = [...section.matchAll(/^\|\s*`([a-zA-Z<>]+)`\s*\|/gm)].map((m) => m[1]);
    expect(justified.length, "no permissions found in the requested-permissions table").toBeGreaterThan(0);
    for (const perm of justified) {
      expect(declared, `PERMISSIONS.md requests \`${perm}\` but the manifest does not`).toContain(perm);
    }
  });
});

describe("link currency", () => {
  const CANONICAL_REPO = "ACR-LOGIC/governworld-extension";
  // Names the repository has had. The current one must be the only one used.
  const STALE_REPO_NAMES = [
    "ACR-LOGIC/governworld-chrome-extension",
    "ACR-LOGIC/governworld/issues",
    "ACR-LOGIC/governworld\"",
    "ACR-LOGIC/governworld`",
    "ACR-LOGIC/governworld>",
  ];

  const LINKED = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "PRIVACY.md",
    "PERMISSIONS.md",
    "STORE_DESCRIPTION.md",
    "STORE_READINESS.md",
    "CHROMEWEBSTORE.md",
    "src/popup/index.html",
    "src/popup/privacy.html",
    "src/popup/legal.html",
    "src/landing/index.html",
  ];

  it("uses only the current repository name everywhere", () => {
    const offenders: string[] = [];
    for (const file of LINKED) {
      const text = read(file);
      for (const stale of STALE_REPO_NAMES) {
        if (text.includes(stale)) offenders.push(`${file} contains ${stale}`);
      }
    }
    expect(offenders, `stale repository links:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("points every GitHub reference at the canonical repository", () => {
    const found = new Set<string>();
    for (const file of LINKED) {
      for (const m of read(file).matchAll(/ACR-LOGIC\/governworld[a-z-]*/g)) found.add(m[0]);
    }
    expect([...found].sort()).toEqual([CANONICAL_REPO]);
  });

  it("uses exactly one canonical privacy policy URL", () => {
    // /privacy is the *website* policy; the extension has its own notice. A
    // listing that links the wrong one is a real review finding.
    const found = new Set<string>();
    for (const file of [...LINKED, "src/popup/privacy.html"]) {
      for (const m of read(file).matchAll(/governworld\.acrlogic\.com\/[a-z-]*privacy[a-z-]*/g)) {
        found.add(m[0]);
      }
    }
    expect([...found].sort()).toEqual(["governworld.acrlogic.com/chrome-extension-privacy"]);
  });

  it("does not describe the project as open source, which it is not", () => {
    // GovernWorld ships under a source-available licence. Claiming "open source"
    // in a store listing is a misrepresentation of the licence. Denials of the
    // claim ("not open source", "rather than as open source") are the point, so
    // they are filtered out rather than flagged.
    const denial = /\bnot\b|rather than|isn't|source-available|separately licensed|permissive|nor\b/i;
    for (const file of ["CHROMEWEBSTORE.md", "STORE_DESCRIPTION.md", "STORE_READINESS.md", "README.md"]) {
      const text = read(file);
      const claims = [...text.matchAll(/[^.\n]*\bopen[- ]source\b[^.\n]*/gi)]
        .map((m) => m[0].trim())
        .filter((line) => !denial.test(line));
      expect(claims, `${file} calls the project open source:\n${claims.join("\n")}`).toEqual([]);
    }
  });
});

describe("store listing metadata", () => {
  const cws = read("CHROMEWEBSTORE.md");

  it("keeps the name and description within store limits", () => {
    // Chrome Web Store: name <= 45, description <= 132.
    expect(manifest.name.length).toBeLessThanOrEqual(45);
    expect(manifest.description.length).toBeLessThanOrEqual(132);
    expect(manifest.name.trim()).toBe(manifest.name);
    expect(manifest.description.trim()).toBe(manifest.description);
  });

  it("uses a semver version Chrome will accept", () => {
    expect(manifest.version).toMatch(/^\d+(\.\d+){0,3}$/);
    // Chrome rejects leading zeroes in version components.
    for (const part of manifest.version.split(".")) expect(String(Number(part))).toBe(part);
  });

  it("names a single purpose and does not advertise the disabled cloud mode", () => {
    expect(cws).toMatch(/Single Purpose/i);
    // The gateway adapter is deliberately not implemented; the worker rejects
    // mode:"cloud" fail-closed. Advertising it would be a false claim.
    expect(read("STORE_DESCRIPTION.md")).not.toMatch(/cloud analysis (is )?(available|enabled)/i);
  });

  it("ships the required icon sizes", () => {
    for (const size of ["16", "32", "48", "128"]) {
      expect(manifest.icons, `manifest.icons["${size}"]`).toHaveProperty(size);
    }
    // 128x128 is the store's required icon size.
    expect(manifest.icons["128"]).toBe("icons/icon-128.png");
  });
});
