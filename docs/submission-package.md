# Chrome Web Store submission package

Everything needed to submit, in the order the dashboard asks for it. Every value
below is verified against the built artifact; nothing here needs to be
re-derived at upload time.

- **Target:** Chrome Web Store, single purpose, listing type "Extension"
- **Artifact:** `release/governworld-redaction-0315091.zip`
- **Artifact SHA-256:** `7F2DBD1C9A3B3DA8633204AFB63480B7281DD46D88BF6809E17D300937E14450`
- **Version:** 0.1.1
- **Published:** https://github.com/ACR-LOGIC/governworld-extension/releases/tag/v0.1.1

> The SHA previously recorded here (`67B9D565…`) never matched the artifact it
> named — it drifted while the package was repointed across releases. It is now
> the digest of the file actually being uploaded, and `npm run verify:digests`
> checks the store assets. Verify the zip itself with:
> `certutil -hashfile release\governworld-redaction-0315091.zip SHA256`
- **Digests for every uploaded file:** `npm run verify:digests`

---

## 1. Package

Upload `release/governworld-redaction-0315091.zip`. That is the file the
dashboard wants — not the tarball, and not `dist/`.

Verified in the zip itself: `manifest_version: 3`, 28 files, `manifest.json` at
the archive root with no wrapping folder.

> If you rebuild before submitting, the filename and both digests change.
> Re-run `npm run release:zip <sha>` and `npm run verify:digests` first.

## 2. Store listing fields

| Field | Value | Limit | Status |
|---|---|---|---|
| Name | `GovernWorld Redaction` | 45 | 21 ✅ |
| Short description | `Local-first PII/PHI detection and redaction for pages and documents you choose to scan. Content stays on this device.` | 132 | 117 ✅ |
| Category | Productivity | — | — |
| Language | English (UI ships in 7) | — | — |

**Detailed description:** the body of `STORE_DESCRIPTION.md`, minus its two
header lines ("Draft listing copy…" and "Review before submission…"). That is
5,084 characters against a 16,000 limit.

## 3. Graphics

| Asset | File | Size | Requirement |
|---|---|---|---|
| Small promo tile | `release/images/promo-tile-440x280.png` | 440×280 | ✅ |
| Screenshots (5) | `release/screenshots/01..05-*.png` | 1280×800 each | ✅ at least one required |

All images are generated from synthetic fixtures by `npm run capture:store` and
`npm run capture:promo`. No real PII, no browser chrome, no user data.

> **Before resubmitting: regenerate.** `04-document-studio.png` was captured
> while the popup still had the decorative "Protection Active" banner, which
> 0.1.1 removes. Run `npm run capture:store`, then `npm run verify:digests`.
> Consider capturing the new full-screen review page instead or as well — it is
> now the surface where redaction actually happens.

## 4. Privacy practices questionnaire

Answer as written. These are the defensible answers, and they match the shipped
permissions exactly — a mismatch here is the most common cause of a rejection
and a bad look.

| Question | Answer | Why |
|---|---|---|
| Single purpose | Detect and redact sensitive data in a page or document the user explicitly opens | No other purpose exists in the code |
| Collect user data? | **No** | Nothing is collected. `PRIVACY.md` describes local-only processing |
| Remote code? | **No** | All OCR/PDF/worker assets are vendored into the package; nothing is fetched or evaluated at runtime |
| Data collection disclosure | Complete the questionnaire as "no data collected" | Consistent with the above |
| Privacy policy URL | `https://governworld.acrlogic.com/chrome-extension-privacy` | Verified HTTP 200 |

## 5. Single-purpose justification

Worth writing out, because a reviewer decides the listing on this.

> GovernWorld Redaction does one thing: it finds sensitive values — PII, PHI,
> financial data, and credentials — in the web page the user is currently
> viewing or in a document the user explicitly opens, and lets the user cover
> them. It requests no install-time host permissions, so a default install has
> no access to any site until the user acts on that site; the always-on paste
> mode adds optional, runtime-granted http(s) access only. It does not modify
> pages, track browsing, sync data, or communicate with an advertising or
> analytics network. Everything it detects, it detects locally.

## 6. Permission justifications

Copy from `PERMISSIONS.md`. The manifest requests `activeTab`, `scripting`,
`storage`, `downloads`, `offscreen`, `sidePanel`, `contextMenus`, plus optional
`notifications` and optional http(s) host access for the always-on paste mode —
and **no install-time host permissions at all**, which is the strongest
privacy statement the listing can make.

## 7. Data safety section

| Field | Value |
|---|---|
| Data usage | No data collected, no data sold, no data used for advertising |
| Remote code | None — all assets vendored |
| Data handling | All processing local; staged document bytes never leave the device |
| Privacy policy | `https://governworld.acrlogic.com/chrome-extension-privacy` |

## 8. Before you press submit

- [ ] `npm run typecheck` clean
- [ ] `npm test` — 58 files / 1,078 tests
- [ ] `npm run build`
- [ ] `npm run release:zip <sha>` and `npm run verify:zip <zip>`
- [ ] `npm run verify:digests` — every recorded digest matches
- [ ] Zip SHA-256 above matches the file you are about to upload
- [ ] `dist/manifest.json` declares no `host_permissions`, and
  `optional_host_permissions` is exactly `http://*/*` + `https://*/*`
- [ ] Read the Terms, Privacy Policy, and STORE_DESCRIPTION once more as a
      reviewer would

## 9. Known limitations to accept, not fix before launch

These are already stated in the legal pages, the privacy policy, and the in-app
notice. They are not blockers; they are the honest scope of the product.

- **Detection is not exhaustive.** A deliberately formatted value can evade the
  patterns. Detection can also produce false positives — a well-formed random
  number such as `123-45-6789` satisfies every SSA structural rule and is
  indistinguishable from a real SSN by shape alone.
- **No independent third-party security assessment.** The sign-off in
  `RELEASE_EVIDENCE.md` is first-party, recorded as such.
- **Community rules are inert.** Both network paths refuse, the UI says so, and
  the pack verifier is tree-shaken out of the shipped bundle.
- **Paste Shield defaults to this-tab**, not always-on: it is absent from any
  tab the user has not activated, because a default install has no site
  access. Always-on is an explicit opt-in behind a runtime permission grant.
- **English only for image OCR.** Detection is language-agnostic regex, so
  structured identifiers in other languages are still found.
- **Chromium first.** The Firefox package (`npm run build:firefox`) ships page
  protection; its Document Studio reports an explicit error where the offscreen
  API is absent. Safari has a handoff payload only — packaging needs Apple
  tooling (see `BROWSER_SUPPORT.md`).
