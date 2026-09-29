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

describe("no claim outruns the implementation", () => {
  it("does not describe processing as '100% local'", () => {
    for (const file of MARKETING) {
      expect(prose(read(file)), `${file} claims 100% local`).not.toMatch(/100%\s*(local|on-device)/i);
    }
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

describe("privacy statements match the code", () => {
  it("does not promise deletion on service-worker restart", () => {
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
