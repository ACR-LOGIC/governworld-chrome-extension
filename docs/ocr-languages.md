# OCR languages

## Current state: English only

This build vendors `eng.traineddata.gz` and nothing else. That is deliberate.

`src/shared/ocrLanguages.ts` is the single source of truth. The build reads it
to decide which traineddata to copy into `dist/assets/`; the OCR worker refuses
any language that is not in it; and the popup builds its language selector from
the same list. There is no second list to fall out of sync.

This matters because the three used to disagree. The markup offered English,
Spanish, French, German, Japanese and Portuguese while the build vendored only
English, so selecting Japanese ran English OCR and reported success — a silent
wrong-answer path in a tool whose output people rely on to disclose documents.
An unbundled language is now **rejected fail-closed** with a thrown error rather
than falling back, so the failure is loud and cannot be mistaken for a scan.

`tests/ocr-bundled-languages.test.ts` enforces the agreement, and
`npm run test:offline-ocr` proves recognition works from `dist/assets` with no
network.

## Why only image OCR is affected

Detection is language-agnostic regular expressions. A Spanish, Japanese or
Arabic document still has its structured identifiers found — payment cards,
SSNs, IBANs, emails, phone numbers, national identifiers — because those match
on shape, not on language. What is English-only is reading an **image** of
non-Latin text, which requires the traineddata.

So the practical gap is narrower than "non-English is unsupported": it is
"non-English text inside a scanned image or screenshot".

## Adding a language

This is a **vendoring decision**, not a code change, because of the size.

1. Obtain the official `traineddata.gz` for the language from the tesseract
   tessdata repository. Do not hand-modify it.
2. Drop it into `vendor/tessdata/` next to `eng.traineddata.gz`.
3. Add an entry to `BUNDLED_OCR_LANGUAGES` in `src/shared/ocrLanguages.ts` with
   its `code`, `label`, and `file`. That single edit is the whole code change;
   the build, the worker, and the selector all follow from it.
4. Update the OCR guide card copy in `src/popup/index.html` if the wording
   implies a single language, then run `npm run sync:sidepanel`.
5. Run the gates: `npm run typecheck`, `npm test`,
   `npm run test:offline-ocr`, and `npm run test:photo-e2e`.

`tests/claims-accuracy.test.ts` fails if any document or the in-app guide card
advertises a language the build does not bundle, so step 4 is enforced rather
than advisory.

## The size trade

Budget roughly **10 MB compressed per additional language**, vendored into the
package. This is paid by every user at install whether or not they ever scan a
document in that language.

- **2 languages** (English + one): ~10 MB added. Reasonable for a market with a
  clear second language.
- **6 languages**: ~50 MB added, and most users download 40 MB they will never
  need. This is why the original six-language claim was a problem and not just
  a documentation bug.
- **Many languages**: consider on-demand download into IndexedDB with a cache.
  That is a genuine option, but it **adds a network path to the document
  pipeline**, which currently has none by design, and so it needs its own
  decision and threat review rather than being folded into a language addition.

If the user base turns out to need many languages, the on-demand model is the
one that scales, and it should be decided on its own terms.
