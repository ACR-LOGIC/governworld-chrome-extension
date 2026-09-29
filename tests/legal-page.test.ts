// Contract for the Terms & Conditions page and its wiring from Settings > About.
//
// legal.html is a standalone document (like privacy.html): it is not part of the
// i18n dictionary and is not loaded through the popup's script. That makes it easy
// to ship a page nobody can reach, or to reach one that never got copied into
// dist/. These assertions cover both ends of that path, plus the two things that
// must stay true of the page: it is served under the extension's CSP, and its
// legal claims do not drift into promising something the product does not do.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const legal = readFileSync(join(extRoot, "src/popup/legal.html"), "utf8");
// Prose is asserted against the text content, not the markup: inline <strong>
// inside a sentence is a formatting choice, and a test that breaks when someone
// bolds half a word is a test that gets deleted instead of fixed.
const legalText = legal
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ");
const popupHtml = readFileSync(join(extRoot, "src/popup/index.html"), "utf8");
const popupTs = readFileSync(join(extRoot, "src/popup/popup.ts"), "utf8");
const build = readFileSync(join(extRoot, "build.mjs"), "utf8");

describe("legal.html (Terms & Conditions)", () => {
  it("is a complete standalone document", () => {
    expect(legal).toMatch(/<!doctype html>/i);
    expect(legal).toContain("<html lang=\"en\">");
    expect(legal).toContain("</html>");
    expect(legal).toContain("<title>GovernWorld - Terms &amp; Conditions</title>");
  });

  it("declares a version and effective date so the terms are identifiable", () => {
    expect(legal).toMatch(/Terms &amp; Conditions v\d+\.\d+\.\d+/);
    expect(legal).toMatch(/Effective [A-Z][a-z]+ \d{1,2}, \d{4}/);
  });

  it("states the extension is free, which is the core commercial term", () => {
    expect(legalText).toMatch(/provided free of charge/i);
    // Section 02 must exist and carry the free guarantee.
    expect(legal).toMatch(/id="s2-title">The Extension is provided free of charge/);
  });

  it("carries the as-is / no-warranty terms", () => {
    expect(legalText).toMatch(/"as is"/);
    expect(legalText).toMatch(/without warranty of any kind/i);
  });

  it("does not promise to detect everything, even with a fully passing test suite", () => {
    // The distinction the page has to make explicit: the detection logic's own
    // tests passing is not a coverage claim about the user's documents.
    expect(legalText).toMatch(
      /does not promise to detect everything, and passing its own tests does not change that/i,
    );
    expect(legalText).toMatch(/A 100% pass rate in testing is not a promise of 100% detection in use/i);
    expect(legalText).toMatch(/They do not measure coverage of the cases we did not/i);
    expect(legalText).toMatch(
      /No test result, coverage figure, or accuracy claim[^.]*is a representation that the Extension will find every sensitive value/i,
    );
  });

  it("places the duty to verify on the user, and states it as a responsibility", () => {
    expect(legal).toMatch(/id="s5-title">You must check every result yourself/);
    expect(legalText).toMatch(/verifying everything it does is your responsibility, not ours/i);
    expect(legalText).toMatch(/You are responsible for verifying every result before you rely on it/i);
  });

  it("caps nothing: liability is excluded, not limited to a monetary figure", () => {
    // A fixed figure was deliberately removed. Assert it does not creep back in.
    expect(legalText).not.toMatch(/USD\s?\d/);
    expect(legalText).not.toMatch(/total aggregate liability/i);
    expect(legalText).not.toMatch(/greater of the amount you paid/i);
    // The consequential-damage exclusion is not a cap and stays.
    expect(legalText).toMatch(/indirect, incidental, special, consequential, exemplary, or punitive damages/i);
  });

  it("puts the responsibility for released PII/PHI on the user, not ACR LOGIC", () => {
    expect(legal).toMatch(/id="s4-title">You are solely responsible for what you release/);
    expect(legalText).toMatch(/ACR LOGIC is not responsible for any release of PII, PHI/i);
    expect(legalText).toMatch(/is yours alone/i);
  });

  it("requires the user to verify output rather than trusting a clean result", () => {
    expect(legal).toMatch(/id="s5-title">You must check every result yourself/);
    expect(legalText).toMatch(/Coverage is never complete/i);
  });
  it("does not present compliance presets as a compliance guarantee", () => {
    expect(legalText).toMatch(/not a compliance guarantee/i);
    expect(legalText).toMatch(/solely responsible for determining whether your use of the Extension complies/i);
  });

  it("describes local processing accurately rather than overclaiming", () => {
    expect(legalText).toMatch(/Detection and redaction happens locally/i);
    // The page must not claim content is never transmitted at all: optional cloud
    // analysis exists and is disabled by default, and the copy has to say so.
    expect(legalText).toMatch(/Cloud analysis is disabled and locked off by default/i);
    expect(legalText).not.toMatch(/nothing ever leaves your device/i);
  });

  it("distinguishes the source-available GovernWorld licence from its open-source dependencies", () => {
    expect(legalText).toMatch(/GovernWorld Source-Available Community License/);
    expect(legalText).toMatch(/not an OSI-approved open-source licence/i);
  });

  it("links the privacy policy and lists a contact address", () => {
    expect(legal).toMatch(/href="privacy\.html"/);
    expect(legal).toContain("mailto:legal@acrlogic.com");
    expect(legal).toContain("mailto:privacy@acrlogic.com");
  });

  it("uses no inline script, no eval, and no remote resource", () => {
    expect(legal).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(legal).not.toMatch(/\beval\s*\(/);
    expect(legal).not.toMatch(/new Function\s*\(/);
    // Only relative links and https/mailto externals; no images, CSS, or frames
    // fetched from the network.
    expect(legal).not.toMatch(/<img\b/i);
    expect(legal).not.toMatch(/<link\b/i);
    expect(legal).not.toMatch(/<iframe\b/i);
    const remote = legal.match(/(?:src|href)="(https?:)?\/\/[^"]+"/g) ?? [];
    for (const attr of remote) {
      expect(attr).not.toMatch(/="\/\//); // protocol-relative would bypass the CSP origin check
    }
  });

  it("uses a local stylesheet-free document that still honours the dark theme tokens", () => {
    // Inline <style> is allowed by the CSP (style-src is not restricted here), and
    // privacy.html does the same, so keep the two pages consistent.
    expect(legal).toMatch(/<style>/);
    expect(legal).toContain("--accent");
  });

  it("defines every class it uses and ships no dead selectors", () => {
    // scripts/prune-dead-css.mts only inspects popup.css/sidepanel.css, so this
    // standalone page has no automated guard. A class used but never defined
    // renders unstyled; one defined but never used is dead CSS. Both are easy to
    // introduce when a page is written by copying privacy.html.
    const style = legal.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const body = legal.replace(/<style>[\s\S]*?<\/style>/, "");

    const used = new Set<string>();
    for (const m of body.matchAll(/class="([^"]+)"/g)) {
      for (const c of m[1]!.split(/\s+/)) if (c) used.add(c);
    }
    const defined = new Set<string>();
    for (const m of style.matchAll(/^\s*\.([A-Za-z][A-Za-z0-9_-]*)/gm)) defined.add(m[1]!);

    const undefinedClasses = [...used].filter((c) => !defined.has(c)).sort();
    expect(undefinedClasses, `classes used but not styled: ${undefinedClasses.join(", ")}`).toEqual([]);

    const deadClasses = [...defined].filter((c) => !used.has(c)).sort();
    expect(deadClasses, `selectors defined but never used: ${deadClasses.join(", ")}`).toEqual([]);
  });
});

describe("legal page wiring", () => {
  it("is reachable from Settings > About in the popup markup", () => {
    expect(popupHtml).toContain('id="terms-link"');
    expect(popupHtml).toMatch(/id="terms-link"[\s\S]{0,200}Terms &amp; Conditions/);
  });

  it("puts both legal documents side by side on the About page", () => {
    expect(popupHtml).toContain('id="about-privacy-link"');
    // Terms must not be the only legal link, and privacy must not be stranded on
    // a settings subpage with no companion.
    expect(popupTs).toMatch(/getElementById\("about-privacy-link"\)/);
    expect(popupTs).toMatch(/aboutPrivacyLink\.href = chrome\.runtime\.getURL\("privacy\.html"\)/);
  });

  it("resolves the link at runtime through chrome.runtime.getURL", () => {
    expect(popupTs).toMatch(/getElementById\("terms-link"\)/);
    expect(popupTs).toMatch(/getURL\("legal\.html"\)/);
    // A bare href="#" that never gets rewritten is a dead link, so require the
    // popup to actually assign it.
    expect(popupTs).toMatch(/termsLink\.href = termsUrl/);
  });

  it("is copied into dist/ by the build", () => {
    const line = build
      .split(/\r?\n/)
      .find((l) => l.includes("copyFileSync") && l.includes("legal.html"));
    expect(line, "build.mjs must copy src/popup/legal.html into dist/").toBeDefined();
    expect(line).toContain('"src/popup", "legal.html"');
    expect(line).toContain('join(outDir, "legal.html")');
  });

  it("is present in dist/ after a build, next to privacy.html", () => {
    const dist = join(extRoot, "dist", "legal.html");
    if (!existsSync(join(extRoot, "dist"))) return; // dist/ is gitignored; skipped without a build
    expect(existsSync(dist)).toBe(true);
    expect(readFileSync(dist, "utf8")).toContain("Terms &amp; Conditions");
  });
});
