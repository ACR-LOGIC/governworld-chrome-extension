// Guards against re-introducing claims the implementation does not support.
//
// An adversarial review of this extension found that several statements
// outran what the code does. Each is technically defensible, and each would
// mislead a security reviewer who checks:
//
//   - "100% local"            the extension does talk to a community service and
//                              an API layer; only local scanning is local.
//   - "proactive" paste guard  with no host permissions and no declarative
//                              content scripts, the guard is absent from any tab
//                              the user has not activated.
//   - "tamper-evident" audit  a signature proves an export is unaltered, not
//                              that the log is a complete history.
//   - six OCR languages       only English traineddata was ever vendored.
//
// This asserts the corrected wording is present, so a later edit that restores the
// stronger claim fails here rather than in a review.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_OCR_CODES, BUNDLED_OCR_LANGUAGES } from "../src/shared/ocrLanguages.js";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(extRoot, rel), "utf8");

const MARKETING = [
  "README.md",
  "CONTRIBUTING.md",
  "PERMISSIONS.md",
  "STORE_DESCRIPTION.md",
  "CHROMEWEBSTORE.md",
  "STORE_READINESS.md",
  "src/landing/index.html",
];

/** Strip code spans and links so a claim in an example does not trip the check. */
function prose(text: string): string {
  return text.replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ");
}

/**
 * Text with only code spans stripped - URLs deliberately kept.
 *
 * The badge "Architecture-100% Local-First" is real, shipped wording that
 * asserted an absolute the product does not honour, and `prose()` missed it
 * precisely because the phrase lives inside a shields.io URL, which prose()
 * strips before the check ever sees it. A claim hidden in a URL is still a
 * claim, and a badge is the most-read line in a README. This variant exists so
 * the claim is still checked after the URL is stripped out of the *rendered*
 * badge text.
 */
function proseKeepingUrls(text: string): string {
  return text.replace(/`[^`]*`/g, " ");
}

describe("no claim outruns the implementation", () => {
  it("does not describe processing as '100% local', including in badges and URLs", () => {
    for (const file of MARKETING) {
      expect(prose(read(file)), `${file} claims 100% local in prose`).not.toMatch(
        /100%\s*(local|on-device)/i,
      );
      // The gap that let the badge through: the phrase was URL-encoded inside a
      // shields.io badge, so stripping URLs removed the claim before the check.
      const raw = proseKeepingUrls(read(file));
      const decoded = raw
        .replace(/%20/g, " ")
        .replace(/%25/g, "%")
        .replace(/%7C/g, "|")
        .replace(/&/g, " ");
      expect(decoded, `${file} claims 100% local in a badge or URL`).not.toMatch(
        /100%\s*(local|on-device)/i,
      );
    }
  });

  it("does not claim any data never leaves the device", () => {
    // Page text and documents genuinely never leave, and that narrower claim is
    // what the copy now makes. The unqualified version is not defensible while
    // account linking and the community surface exist.
    for (const file of [...MARKETING, "src/popup/index.html"]) {
      const text = proseKeepingUrls(read(file)).replace(/\s+/g, " ");
      const broad = /your data never leaves|without any data ever leaving|strictly local/i;
      expect(text, `${file} makes an absolute egress claim`).not.toMatch(broad);
    }
  });

  it("keeps the narrower claim that page text and documents never leave", () => {
    // Over-correcting into vagueness would be its own failure: the guarantee is
    // real and users deserve it stated plainly.
    for (const file of ["STORE_DESCRIPTION.md", "CHROMEWEBSTORE.md"]) {
      expect(read(file), `${file} dropped the egress guarantee`).toMatch(
        /page text and documents never leave/i,
      );
    }
  });

  it("does not advertise a browser the build does not produce", () => {
    // manifest.firefox.json is MV2 and is not packaged by the build, and Safari
    // cannot load a Chrome extension. Advertising either as shipped is a claim a
    // reviewer can falsify in about a minute.
    const readme = read("README.md");
    expect(readme).not.toMatch(/badge\/Browsers-[^)]*Firefox/i);
    expect(readme).not.toMatch(/badge\/Browsers-[^)]*Safari/i);
    expect(readme).toMatch(/Not supported in this build/i);
    expect(readme).toMatch(/not supported/i);
  });

  it("does not hard-code a test count that will drift", () => {
    // A stale count in a README is worse than no count, and it is what was
    // wrong here: it still said 31 suites / 546 tests long after the suite grew.
    const readme = read("README.md");
    expect(readme, "README hard-codes a test count").not.toMatch(
      /\d+\s+(?:vitest\s+)?test suites?\s*[/(\s]\s*\d*\s*tests/i,
    );
    expect(readme, "README hard-codes a test count").not.toMatch(/\d{3,}\s+tests\s+passing/i);
  });

  it("states that local processing is the default, not that nothing ever leaves", () => {
    const contributors = read("CONTRIBUTING.md");
    expect(prose(contributors)).toMatch(/local processing by default/i);
  });

  it("does not call the paste guard proactive", () => {
    for (const file of MARKETING) {
      expect(prose(read(file)), `${file} calls the paste guard proactive`).not.toMatch(/proactive/i);
    }
  });

  it("explains when the paste guard is and is not active", () => {
    // Collapsed first: the prose is hard-wrapped, so "no host\npermissions"
    // is one sentence to a reader and two unmatched tokens to a regex.
    const readme = read("README.md").replace(/\s+/g, " ");
    // The honest statement has to name the gap, not just soften the adjective.
    expect(readme).toMatch(/on-demand, not always-on/i);
    expect(readme).toMatch(/without touching GovernWorld first/i);
    expect(readme).toMatch(/no host permissions/i);
  });

  it("does not call the audit log tamper-evident", () => {
    for (const file of MARKETING) {
      expect(prose(read(file)), `${file} calls the audit log tamper-evident`).not.toMatch(/tamper[- ]evident/i);
    }
  });

  it("scopes the audit signature to what it actually proves", () => {
    const store = read("CHROMEWEBSTORE.md");
    expect(store).toMatch(/does not prove the log is a complete history/i);
  });

  it("advertises only the OCR languages that are bundled", () => {
    for (const file of MARKETING) {
      const text = read(file);
      // No document may list a language code the package cannot read offline.
      for (const lang of ["spa", "fra", "deu", "jpn", "por"]) {
        if (BUNDLED_OCR_CODES.includes(lang)) continue;
        const claimsMulti = new RegExp(`OCR[^.]{0,80}\\b${lang}\\b|\\b${lang}\\b[^.]{0,40}OCR`, "i");
        expect(prose(text), `${file} advertises unbundled OCR language ${lang}`).not.toMatch(claimsMulti);
      }
    }
  });

  it("does not name unbundled languages in the in-app OCR guide card", () => {
    // This is the claim a user actually reads at the point of choosing a
    // language, so it matters more than the README; it is plain markup, so no
    // type-check or i18n key would catch a stale list here.
    for (const file of ["src/popup/index.html", "src/sidepanel/sidepanel.html"]) {
      const card = read(file).match(/id="guide-ocr-languages"[\s\S]{0,600}?<\/div>/)?.[0];
      expect(card, `${file} has no OCR guide card`).toBeDefined();
      const text = card as string;
      for (const name of ["Spanish", "French", "German", "Japanese", "Portuguese"]) {
        expect(text, `${file} guide card offers unbundled ${name}`).not.toContain(name);
      }
      // Every bundled language must still be named, or the card is useless.
      for (const { code, label } of BUNDLED_OCR_LANGUAGES) {
        expect(text.toLowerCase(), `${file} guide card omits bundled ${code}`).toContain(
          label.toLowerCase(),
        );
      }
    }
  });

  it("keeps the interface-translation list intact", () => {
    // The seven UI languages are a real feature and are unrelated to OCR. A
    // fix that collapsed them along with the OCR claim would be its own bug.
    const readme = read("README.md");
    expect(readme).toMatch(/interface translation/i);
    expect(readme).toMatch(/English/);
  });
});

describe("disabled community features are not advertised as live", () => {
  // Both community network paths are stubbed off in the service worker and
  // return an error. The in-app copy has to say so, or the first support
  // question is "I clicked contribute and nothing happened" and the first
  // reviewer question is whether the listing misrepresents the feature.
  it("states in the UI that community rule packs are not active", () => {
    for (const file of ["src/popup/index.html", "src/sidepanel/sidepanel.html"]) {
      expect(read(file), `${file} does not say community sharing is inactive`).toMatch(
        /not active in this release/i,
      );
    }
  });

  it("does not render a locally generated identity as if it were verified", () => {
    // linkFreeCommunityAccount() creates a local id. Nothing may present it as a
    // server-confirmed identity, so the label is deliberately not surfaced.
    for (const file of ["src/popup/popup.ts", "src/popup/index.html", "src/sidepanel/sidepanel.html"]) {
      expect(read(file), `${file} renders the unverified contributor label`).not.toMatch(
        /displayLabel/,
      );
    }
  });

  it("keeps the service worker stubs returning an error", () => {
    // The copy above is only honest while these are still refusals.
    const sw = readFileSync(join(extRoot, "src/service-worker/index.ts"), "utf8");
    for (const msg of ["POPUP_COMMUNITY_CONTRIBUTE", "POPUP_COMMUNITY_FETCH_COMMUNITY_RULES"]) {
      const idx = sw.indexOf(`case "${msg}"`);
      expect(idx, `${msg} handler not found`).toBeGreaterThan(-1);
      const body = sw.slice(idx, idx + 400);
      // includes(), not a regex: the bracket in `rules: []` is easy to mangle
      // through template interpolation, and an empty character class silently
      // matches nothing, which would turn this into a test that passes for the
      // wrong reason.
      const refuses = body.includes("success: false") || body.includes("rules: []");
      expect(refuses, `${msg} no longer refuses`).toBe(true);
    }
  });
});

describe("privacy statements match the code", () => {  it("does not promise deletion on service-worker restart", () => {
    // MV3 workers are suspended when idle and restarted on the next event, and
    // the extension deliberately does not purge on restart: doing so would
    // delete a document the user was still reviewing. Promising deletion here
    // would let a reader conclude their file is gone when it is not.
    //
    // This matches the old false promises verbatim rather than probing for
    // "deleted" near "service worker restart". The corrected text is a negation
    // of that same claim, so any proximity heuristic flags the honest wording too.
    const FALSE_PROMISES = [
      /or the extension service worker restarts?/i,
      /or the next Extension service-worker startup/i,
      /clear-data, or the next/i,
    ];
    for (const file of ["PRIVACY.md", "src/popup/privacy.html", "PERMISSIONS.md"]) {
      const text = read(file).replace(/\s+/g, " ");
      for (const promise of FALSE_PROMISES) {
        expect(text, `${file} still promises deletion on service-worker restart`).not.toMatch(promise);
      }
    }
  });

  it("states why restart does not purge, rather than only omitting the promise", () => {
    // Dropping the false claim is not enough; a reader needs the reason, because
    // otherwise it looks like an oversight rather than a deliberate choice.
    for (const file of ["PRIVACY.md", "src/popup/privacy.html"]) {
      const text = read(file).replace(/\s+/g, " ");
      expect(text, `${file} does not explain the restart behaviour`).toMatch(
        /not (deleted|removed) (merely )?because/i,
      );
      expect(text, `${file} does not name the real purge trigger`).toMatch(/start the browser|browser startup/i);
    }
  });

  it("names the events that actually purge staged bytes", () => {
    const permissions = read("PERMISSIONS.md");
    expect(permissions).toMatch(/browser startup/i);
    expect(permissions).toMatch(/install\/update/i);
  });
});
