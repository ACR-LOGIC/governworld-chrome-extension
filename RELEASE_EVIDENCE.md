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
| Security review sign-off | ⚠️ **NOT SIGNED for the current artifact.** Prior approval is at `b4c8614` only, which predates the detector, OCR, community-boundary, and claims work. Two independent automated passes have since been run against the full `8cff8ba..HEAD` range: an adversarial probe of the detector and contribution screener, and a Copilot review. Each found a real defect the other missed - the card pattern absorbing a neighbouring number, the case-sensitive auth schemes, and nine contribution-screener normalisation gaps - all now fixed and regression-tested. **A human reviewer has not signed this artifact.** Reviewer checklist in the handoff notes; nothing here should be read as an approval. |
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

### Current (supersedes `dfcf02a`)

| Field | Value |
|-------|-------|
| Commit SHA | `a3138eb` |
| Store ZIP | `release/governworld-redaction-a3138eb.zip`, SHA-256 `BEAA93FE97189596306488260345F4A2EF8E0FAD56C8C58A671D96B6CEB85A7C` |
| Mirror tarball | `release/governworld-redaction-a3138eb.tar.gz` (same payload), SHA-256 `AD4461492609FBD298307A61C83804F05DBB2B1224DE3529C0DA49B6B602FE24` |
| Checksums | `release/SHA256SUMS` |
| Artifact size | 14.4 MB (store limit 2 GB) |
| Lockfile SHA-256 | `CB1A4C62F72D1DFF1E004743BD0747F19596A295000C9C8BFBD6781E286D664E` |
| Zip root | `manifest.json` at archive root, no wrapping folder |
| Manifest | v0.1.0, name 21 chars (limit 45), description 117 chars (limit 132) |
| Permissions | `activeTab`, `scripting`, `storage`, `downloads`, `offscreen`, `sidePanel`, `contextMenus` + optional `notifications` — no host permissions (re-confirmed in the built `dist/manifest.json`) |
| `npm audit` | 0 vulnerabilities |
| Runtime dependencies | pdfjs-dist 6.3.289, tesseract.js 7.0.0, pdf-lib 1.17.1, mammoth 1.13.0 |
| Build runtime | Node 24 in CI (Node 20 reached EOL 2026-04-30; pdfjs-dist 6 needs >=22.13) |
| Packaged-artifact verification | `npm run verify:zip release/governworld-redaction-a3138eb.zip` — extracts the zip and loads it in Chromium; 11 manifest references, 4 offline assets, `privacy.html` + `legal.html` + `redact.html` present and linked, all 6 pages CSP-clean, service worker alive |
| Print pipeline | `npm run verify:print` — real redaction, then opens `redact.html` and asserts the printed page carries redaction pixels at the source page's physical size |
| Photo OCR/redaction E2E | `npm run test:photo-e2e` — 8 findings across 7 categories; each expected value 100% dark; the two prose false-positive guards (`Amount Due: $248.00`, notes prose) unchanged |
| UI walkthrough | `npm run capture:ui` — 26 steps, 0 console errors |

### Previous (superseded, retained for history)

| Field | Value |
|-------|-------|
| `a62aed6` | `release/governworld-redaction-a62aed6.zip` — **do not submit**; predates the claims, OCR fail-closed, and CDN-guard fixes |
| `413b3a7` | `release/governworld-redaction-413b3a7.zip` — **do not submit**; predates the contribution-screener normalisation fixes and the pack verifier |
| `0eb545c` | `release/governworld-redaction-0eb545c.zip` — **do not submit**; predates the case-insensitive auth-scheme fix, so `authorization: bearer <token>` is not masked |
| `7756775` | `release/governworld-redaction-7756775.zip` — **do not submit**; predates the payment-card absorption fix, so it can miss an SSN adjacent to a card number |
| `dfcf02a` | `release/governworld-redaction-dfcf02a.zip` — predates the overlap/secret-format/ReDoS detector fixes, the OCR bundled-language source of truth, the community-boundary validation and contribution screening, and the claims corrections |
| `cbb7d12` | `release/governworld-redaction-cbb7d12.zip`, SHA-256 `8D8C8BB0114D5D5ADE250A385F61BDE4A911D91AB664655D0804AFE852357C91` — predates the dependency upgrades, the new logo, and the print stage |
| `b4c8614` | `release/governworld-redaction-b4c8614.zip`, SHA-256 `3FEEE65D62947E22E9A35674BE2C4AB67699A0520359900FBFA93134D1A9A2CD` — **do not submit**; predates the document-studio transport fix, the active-tab fix, the Terms page, and the About page |

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
2. **Final security review sign-off - outstanding for the current artifact.**
   Approved at `b4c8614` (2026-08-22). The detector, OCR language handling,
   community boundary, and every published claim changed after that point, so
   that approval does not carry over. Two independent automated passes have
   been run over the full `8cff8ba..HEAD` range and each found real defects,
   all since fixed and regression-tested - but automated review is not a human
   sign-off, and a named reviewer still has to accept this artifact.
   Suggested reading order, in descending risk: `src/content/detect.ts`
   (overlap resolution, and any pattern missing `g` or `i`),
   `src/shared/customPatterns.ts` (`normaliseForScan`, and the decision not to
   fold non-ASCII digits), `src/document-pipeline/ocr.ts` (fail-closed language
   handling and `buildOcrWorkerOptions`), then `dist/manifest.json` for the
   absence of `host_permissions`.
3. ~~Commit approval → generate ZIP from that exact commit → record artifact
   SHA-256 here.~~ **Done** at `a3138eb`; ZIP + tar.gz + `release/SHA256SUMS`,
   both carrying an identical 28-file payload, both checksums re-verified
   independently with `Get-FileHash`, and the ZIP proven loadable by
   `npm run verify:zip`.
4. ~~The 440x280 small promo tile.~~ **Done** —
   `release/images/promo-tile-440x280.png`, generated by
   `npm run capture:promo`, dimensions verified from the PNG IHDR.
5. **Open:** the terms name a governing-law jurisdiction that has not been set
   by the developer.
6. **Open:** security sign-off in this file predates the current artifact
   (recorded at `b4c8614`, 2026-08-22). Re-confirm if policy requires sign-off
   on the exact submitted SHA.
7. **Held back:** `@playwright/test` stays pinned at 1.62.1. 1.63.0 requires a
   Chromium build (1243) that could not be downloaded from this network
   (CDN timeout), and the browser E2E suite is the only proof the upgraded
   pdf.js/tesseract.js pipeline works. Everything else is on the latest release.
