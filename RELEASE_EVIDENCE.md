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
| Security review sign-off | ✅ **APPROVED** at commit `b4c8614` (fail-closed messaging, consent gating, metadata-only signed audit, report-only attr scan, fail-closed document pipeline, vendored-only build, synthetic-only fixtures) |
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

| Field | Value |
|-------|-------|
| Approved commit SHA | `b4c8614` |
| Release ZIP | `release/governworld-redaction-b4c8614.zip` via `npm run release:zip b4c8614` |
| Artifact SHA-256 | `3FEEE65D62947E22E9A35674BE2C4AB67699A0520359900FBFA93134D1A9A2CD` |
| Lockfile SHA-256 | `A6AFBE64FDACAEFF9DF689FDE14980C220074E176D4EA626576EC395EEEA51EB` |
| Manifest description length | 117 chars (store limit 132) |
| Permissions | `activeTab`, `scripting`, `storage`, `downloads`, `offscreen`, `sidePanel` + optional `notifications` — no host permissions |
| Cloud analysis | Disabled and rejected server-side (fail closed); local-only enforced |
| ⚠️ Stale | Feature additions landed after `b4c8614` (side panel, notifications, account linking, Developer/secrets preset, redaction labels, landing page). **Regenerate the ZIP from the new approved commit and re-record the artifact SHA-256 before store submission.** |

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

1. Host `PRIVACY.md` at the canonical public URL and reference it in the
   store listing.
2. ~~Final security review sign-off.~~ ✅ **APPROVED** at `b4c8614`
   (2026-08-22).
3. ~~Commit approval → generate ZIP from that exact commit → record artifact
   SHA-256 here.~~ ✅ Done at `b4c8614`; ZIP
   `release/governworld-redaction-b4c8614.zip`, SHA-256 recorded above.
