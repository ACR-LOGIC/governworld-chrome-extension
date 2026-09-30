# GovernWorld Redaction — Release Evidence

Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

Immutable record of the verification performed for the Chrome Web Store
release build. Synthetic-only fixtures; no real PII/PHI in any asset.

## Verification results (2026-08-21)

| Gate | Result |
|------|--------|
| `npm run typecheck` (extension) | ✅ Pass |
| Extension unit tests (`npm test`) | ✅ 104 passed / 0 failed (11 files) |
| Root core tests (`npm test` at repo root) | ✅ 2034 passed, 49 skipped / 0 failed |
| Production build (`npm run build`) | ✅ Pass (`dist/`, offscreen bundle 1.3MB incl. mammoth) |
| Offline OCR smoke test (`npm run test:offline-ocr`) | ✅ Pass ("HELLO", no network) |
| Dependency audit (`npm audit --omit=dev`) | ✅ 0 vulnerabilities |
| Secret scan (regex sweep: keys/tokens/private-key blocks) | ✅ Clean (3 benign hits reviewed: synthetic test values, doc prose, password-field exclusion selector) |
| PII/PHI asset review | ✅ Fixtures use reserved synthetic values only (`123-45-6789`, `example.com/net`, `4111 1111 1111 1111`, `555-01xx`); screenshots captured from the synthetic fixture page |

## Release verification (2026-08-22, pre-submission)

| Gate | Result |
|------|--------|
| `npm run typecheck` (extension) | ✅ Pass |
| Extension unit tests (`npm test`) | ✅ 115 passed / 0 failed (11 files) |
| Production build (`npm run build`) | ✅ Pass |
| Offline OCR smoke test (`npm run test:offline-ocr`) | ✅ Pass ("HELLO", no network) |
| Security review sign-off | ✅ **APPROVED by the principal** (Andres Chavez Ramirez, author and sole maintainer) on 2026-09-29, after reading this file. Assurance level is **first-party**: the reviewer is the author, so this is not an independent third-party assessment and should not be presented as one. Supporting automated review, run over the full `8cff8ba..HEAD` range: an adversarial probe of the detector and contribution screener, and a Copilot review. Each found real defects the other missed - the card pattern absorbing a neighbouring number, the case-sensitive auth schemes, nine contribution-screener normalisation gaps, and the OCR silent fallback - all fixed and regression-tested, each guard proven to fail against the unfixed code. Residual risk accepted and documented below. |
| Release-blocker fixes | ✅ DOCX offscreen gate closed (was silently dropped → 180s timeout); SCAN_RESULT bound to pending sessionId; mask-command responses verified; release tooling requires explicit approved commit + clean tree; `gatewayOrigin` validated as https origin (deny-by-default) |

## Feature additions (2026-08-23, `feat/chrome-extension-release`)

| Feature | Status |
|---------|--------|
| Side panel (`sidePanel` permission, `Alt+Shift+P`) | ✅ Persistent panel reuses the popup wiring (shared `initPopup`) and adds notifications + account sections |
| Notifications (optional permission, requested at runtime) | ✅ Scan-findings notification only when the user enables the toggle AND grants `notifications`; never required at install |
| Optional-permission UX | ✅ `notifications` moved to `optional_permissions`; requested via `chrome.permissions.request` on enable, removed on disable |
| Account linking (profile + extension add-on) | ✅ Side panel stores a user-provided gateway origin + `gw_` API key (fail-closed, no new onboarding/tenants); shows linked profile; purchase opens the existing `/v1/billing/checkout` Stripe flow |
| Backend add-on capability | ✅ `browser.redaction_extension` registered on the canonical capability registry; `redaction-extension-addon` plan (env-activated `GOVERNWORLD_EXTENSION_ADDON_PRICE_ID`) grants/revokes it through the existing checkout/webhook/provisioner; provisioning via `npm run billing:provision-products` |

## Feature additions (2026-08-23, second batch)

| Feature | Status |
|---------|--------|
| Developer preset + secrets detection | ✅ `secrets` category (API keys/secrets: OpenAI, Anthropic, Google, Stripe, GitHub, Slack, SendGrid, npm, Twilio, Databricks, AWS, Azure, private keys, JWT, connection strings, credential assignments); Developer preset + Custom option |
| Preset auto-select + revert to Custom | ✅ HIPAA/PCI/GDPR/Developer auto-select their covered categories; unchecking any box reverts to Custom |
| Preset transitions in audit log | ✅ `preset_applied` / `preset_overridden` events (metadata + active category set) recorded in the signed audit trail |
| "Verify your work" notice | ✅ One-time dialog after first scan (pattern-based detection is not guaranteed complete); `verificationNoticeAcknowledged` setting |
| Instructions section | ✅ Side panel "Instructions" (page scanning, shortcuts, side panel, documents, accuracy) |
| Landing page | ✅ `landing.html` with Overview / Security / Privacy / About Us / About This Extension tabs; served at preview root |
| Redaction labels | ✅ Optional `maskPlaceholders` setting — white labels on mask blocks (`[SSN]`, `[DOB]`, `[API KEY]`, …), off by default; threaded SCAN_PAGE → content script → overlay |

## Release verification (2026-08-23, second batch)

| Gate | Result |
|------|--------|
| `npm run typecheck` (extension) | ✅ Pass |
| Extension unit tests (`npm test`) | ✅ 138 passed / 0 failed (11 files) |
| Production build (`npm run build`) | ✅ Pass (`landing.html` copied to dist) |
| Offline OCR smoke test (`npm run test:offline-ocr`) | ✅ Pass ("HELLO", no network) |
| Preview server (`npm run preview`) | ✅ Serves landing / sidepanel / popup on localhost:8333 |

## Release artifact

### v0.1.1 (current; supersedes `c273fd0` / v0.1.0)

v0.1.0's document path processed correctly and looked completely inert: a user
picked a file, waited 6–20 seconds seeing no status, no spinner and no error, and
lost the document if they looked away. v0.1.1 fixes that and adds a usable route
for a page that *is* an image. `0.1.0` is left published as-is; the new tag
supersedes it rather than rewriting a published release.

| Field | Value |
|-------|-------|
| Commit SHA | `0315091` |
| Version | 0.1.1 |
| Store ZIP | `release/governworld-redaction-0315091.zip`, SHA-256 `7F2DBD1C9A3B3DA8633204AFB63480B7281DD46D88BF6809E17D300937E14450` |
| Mirror tarball | `release/governworld-redaction-0315091.tar.gz` (same payload), SHA-256 `E4D93403197AB720548F67B13534E38DCAE6C4D6F623A5463B8ADA881A3AFC5B` |
| Checksums | `release/SHA256SUMS` |

### What changed in v0.1.1

| Area | Fix |
|------|-----|
| Document feedback | `#doc-status` shipped with `hidden` and nothing lifted it, so every status *and every error* rendered into a `display:none` element; `setDocStatus` also wrote to the wrapper instead of the `#doc-status-text` paragraph the markup provides. |
| Progress | `resetDocStages()` hid the progress row and nothing re-showed it during a 6–20s preview; the success path re-showed it, leaving a permanent "Processing document…" spinner and Cancel button on a finished document. |
| Worker refusals | Document call sites fired and forgot the reply, discarding every `{ ok: false, error }`. A refused request was indistinguishable from a slow one. |
| Initialisation | `void initPopup()` swallowed a rejection. Init awaits settings before attaching a single listener, so a failure left working markup with no behaviour at all. |
| Textless pages | A page that *is* an image scans to 0 characters and reported **"Completed securely on-device"** — a clean bill of health for a document full of PII. `visibleChars === 0` now takes a dedicated error branch naming the image case. |
| Image route | The scan reports `imageCandidates`; the popup offers each one. **Green** = original bytes read at full resolution; **amber** = rendered capture only, which OCRs worse. No host permissions added. |
| Drawing | The popup is a 360px column, so a page of text renders at ~1/10 size and a box lands on unreadable pixels. `review.html` shows the document at full size with the controls in a side panel. A drawn box id must start with `custom:`, which the worker validates. |
| Session durability | The session was in-memory only, so closing the popup lost the document. It is persisted and rebuilt from IndexedDB. |
| Storage | The popup and worker each had their own `openDb`; a blocked `indexedDB.open` fires neither `success` nor `error`, so callers awaited forever. Now one shared, bounded implementation. |
| Worker lifecycle | One transient purge failure latched `startupCleanupError` and rejected *every* message for the worker's lifetime. A reclaimed offscreen document stalled the full 180s timeout; it now fails fast and retries. |
| Popup space | Removed the decorative "Protection Active" hero: it asserted protection was running whether or not a scan had ever run. |

| Verification gate | Result |
|------|--------|
| `npm run typecheck` | ✅ Pass |
| `npm test` | ✅ **1112 passed / 0 failed (59 files)** |
| `npm run build` | ✅ Pass |
| `npx vitest run tests/dist-manifest.test.ts tests/offline-assets.test.ts` | ✅ 11 passed |
| `npm run sync:sidepanel:check` | ✅ ok |
| `npm run test:doc-flow` | ✅ Document Studio end-to-end in real Chromium: pick PDF → progress → 12 findings → spinner stops → survives reload → redact → download → print view |
| `npm run test:no-text` | ✅ Image-only page does not claim success; a text page still does |
| `npm run test:image-capture` | ✅ Textless page offers its image; OCR finds 8 findings; redact writes a file |
| `npm run test:review` | ✅ Draws a real box (8→9 findings), **2,174,960 black pixels painted**, whiteout repaints, select/clear work, download completes |
| Mutation check | Reverting the `custom:` box-id prefix fails `test:review` with the worker's real error ("The selected findings are no longer available") |

**Security review sign-off for 0.1.1: NOT YET OBTAINED.** The approval recorded
below covers v0.1.0 (`c273fd0`). These changes alter the document and redaction
path, so the previous sign-off does not carry over. The reviewer is the author
and sole maintainer; even once given, assurance level is **first-party** and must
not be presented as an independent third-party assessment.

### Previous: v0.1.0 (`c273fd0`)

| Field | Value |
|-------|-------|
| Commit SHA | `c273fd0` |
| Store ZIP | `release/governworld-redaction-c273fd0.zip`, SHA-256 `C74E7FCB85F888B1A75F36D02DF28DFCDE20F8F2AF2602F70A8E48295487EB8C` |
| Mirror tarball | `release/governworld-redaction-c273fd0.tar.gz` (same payload), SHA-256 `2D6367B97517DC4D1907D8FDD8EB15792B2006E85194D6737FAE9F21DD686774` |
| Checksums | `release/SHA256SUMS` |
| Artifact size | 14.4 MB (store limit 2 GB) |
| Lockfile SHA-256 (as committed in git, LF) | `CB1A4C62F72D1DFF1E004743BD0747F19596A295000C9C8BFBD6781E286D664E` | **Careful:** a Windows checkout with `core.autocrlf=true` materialises CRLF line endings, so hashing the *working-tree* file yields `830BC33A7045CE4D1802E2B44FA09C0D9B2BF9824E51A144C8ADF3E7714B50F2` instead. Both are correct for what they measure. Verify against the committed content with `git show HEAD:package-lock.json` rather than hashing the working tree. |
| Zip root | `manifest.json` at archive root, no wrapping folder |
| Manifest | v0.1.0, name 21 chars (limit 45), description 117 chars (limit 132) — superseded by v0.1.1 |
| Permissions | `activeTab`, `scripting`, `storage`, `downloads`, `offscreen`, `sidePanel`, `contextMenus` + optional `notifications` — no host permissions (re-confirmed in the built `dist/manifest.json`) |
| `npm audit` | 0 vulnerabilities |
| Runtime dependencies | pdfjs-dist 6.3.289, tesseract.js 7.0.0, pdf-lib 1.17.1, mammoth 1.13.0 |
| Build runtime | Node 24 in CI (Node 20 reached EOL 2026-04-30; pdfjs-dist 6 needs >=22.13) |
| Packaged-artifact verification | `npm run verify:zip release/governworld-redaction-c273fd0.zip` — extracts the zip and loads it in Chromium; 11 manifest references, 4 offline assets, `privacy.html` + `legal.html` + `redact.html` present and linked, all 6 pages CSP-clean, service worker alive |
| Print pipeline | `npm run verify:print` — real redaction, then opens `redact.html` and asserts the printed page carries redaction pixels at the source page's physical size |
| Photo OCR/redaction E2E | `npm run test:photo-e2e` — 8 findings across 7 categories; each expected value 100% dark; the two prose false-positive guards (`Amount Due: $248.00`, notes prose) unchanged |
| UI walkthrough | `npm run capture:ui` — 26 steps, 0 console errors |


### Store asset digests (SHA-256)

The Chrome Web Store listing uploads these images separately from the extension
zip, so the zip checksum does not cover them. Digests of the committed files:

> **Stale for v0.1.1.** `04-document-studio.png` was captured while the popup
> still had the decorative "Protection Active" hero, which has since been
> removed. The other screenshots are unaffected. Regenerate with
> `npm run capture:store` before resubmitting the listing, then re-run
> `npm run verify:digests`. The digests below are left as-is deliberately, so a
> drift here fails CI loudly rather than passing on an image that no longer
> matches the product.

```
A707493D3E702E0A6BE3E2D430C1736299FDB2AE6A6C2AD10C418B594C7ED5B9  release/images/promo-tile-440x280.png
C25E77DEE0DB11AE8290C819A942B65395A6E8869421632EAE48A5043BDC109B  release/screenshots/01-protection-idle.png
7C864FB252B93CCC9260D74387330667BF439F3C431C1242EA37DA8F95F16ADE  release/screenshots/02-findings-masked.png
38A2BE9D248CF98D51B640FA6C57ADA3EE9C75E62FB62F02DD6B1310E2DD3A1D  release/screenshots/03-page-masks-applied.png
F6B8F30C9B75AB86D2EA03D1D57F9A1ED96AF15EEEC5951D5419E4E7B2C103EC  release/screenshots/04-document-studio.png
0281AF692C57497C768C1B086837A2D7C58B9253DFC7C46394E32D758FD52E67  release/screenshots/05-settings-about.png
```

Note that the four `NOTES.md` files under `release/` are documentation and are
excluded. They are text and are subject to the same CRLF caveat as the
lockfile above.
### History rewritten 2026-09-29

The release archives that had been committed before `release/*.tar.gz` was
gitignored have been removed from git history. Every commit SHA on `main`
changed as a result, and the seven superseded archives that used to be listed
here are deleted: they are gitignored build output, each reproducible from its
commit with `npm run release:zip <sha>`.

The pre-rewrite SHAs below no longer resolve, which is the expected
consequence of rewriting published history. They are recorded only so the
rewrite is auditable, not as pointers to anything:

```
dfcf02a  644e0f2  413b3a7  7756775  a62aed6  0eb545c  a3138eb
```

Before the rewrite, `main` held 120.7 MB of reachable objects across 700;
after, 20.1 MB across 669. What remains is `vendor/tessdata/eng.traineddata.gz`
at 10.4 MB, which is tracked because the build requires it, plus the logo
master and the test fixtures. The full analysis, the measurement method, and
the runbook are in `docs/git-history-tarballs.md`.

`licensing/source-available` was left untouched: it contains no tarballs, and
its content is already superseded on `main` (byte-identical `LICENSE`, and the
source-available wording is already in the README). It was not rewritten
because there was nothing to remove.

## Security posture notes

- No remote code execution paths: pdf.js worker, tesseract worker/core/wasm,
  and tessdata are vendored into the package; no external URLs in source.
- CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
- Accessibility-surface scan is report-only: DOM attributes are never
  mutated (proven by mutation-recording fakes in `tests/attrs.test.ts`);
  attribute findings are excluded from masking, redacted copy, and overlays;
  raw attribute values are never persisted (masked previews only).
- Audit log remains metadata-only with ECDSA P-256 detached signatures.

## Remaining external blockers

1. ~~Host `PRIVACY.md` at the canonical public URL and reference it in the
   store listing.~~ **Done** — published at
   `https://governworld.acrlogic.com/chrome-extension-privacy` and linked from
   the popup settings section, `landing.html`, and `STORE_DESCRIPTION.md`.
2. ~~Final security review sign-off.~~ **Done** - approved by the principal on
   2026-09-29 after reading this file. First-party review (the reviewer is the
   author), backed by two automated passes over `8cff8ba..HEAD`. Residual risk
   accepted:
   - Detection is not exhaustive. A determined format can evade it. Stated in the
     Terms, the privacy policy, and the in-app notice.
   - No independent third-party security assessment exists.
   - Community rules are inert: both network paths refuse, and the pack verifier
     is tree-shaken out of the shipped bundle, so the trust model carries no
     runtime risk today.
3. ~~Commit approval → generate ZIP from that exact commit → record artifact
   SHA-256 here.~~ **Done** at `c273fd0`; ZIP + tar.gz + `release/SHA256SUMS`,
   both carrying an identical 28-file payload, both checksums re-verified
   independently with `Get-FileHash`, and the ZIP proven loadable by
   `npm run verify:zip`.
4. ~~The 440x280 small promo tile.~~ **Done** —
   `release/images/promo-tile-440x280.png`, generated by
   `npm run capture:promo`, dimensions verified from the PNG IHDR.
5. **Open:** the terms name a governing-law jurisdiction that has not been set
   by the developer.
6. **Open:** security sign-off in this file predates the current artifact
   (originally recorded at `b4c8614`, 2026-08-22, a commit that no longer exists after the history rewrite). Re-confirm if policy requires sign-off
   on the exact submitted SHA.
7. **Held back:** `@playwright/test` stays pinned at 1.62.1. 1.63.0 requires a
   Chromium build (1243) that could not be downloaded from this network
   (CDN timeout), and the browser E2E suite is the only proof the upgraded
   pdf.js/tesseract.js pipeline works. Everything else is on the latest release.
