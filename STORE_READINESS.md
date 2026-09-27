# GovernWorld Redaction — Chrome Web Store Readiness

Status of the store-submission materials for the local-first redaction
extension. All user-facing copy uses **synthetic examples only**; no real
PII/PHI appears in screenshots, listing copy, or disclosures.

**Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.**

## Listing materials

- **Name:** GovernWorld Redaction
- **Summary:** Detect and redact sensitive values (PII/PHI) on the page you
  are viewing and in the documents you open — locally, on your device.
- **Full description:** See `STORE_DESCRIPTION.md`.
- **Category:** Productivity
- **Primary language:** English
- **Privacy policy URL:** packaged as `PRIVACY.md`; must be hosted at a
  public URL (repo `docs/extensions/` path or company site) before store
  submission.
- **Single purpose:** Find and redact sensitive values in content the user
  explicitly chooses to scan. The extension has one purpose and does not
  change behavior based on the site visited.
- **Permission justification:** `PERMISSIONS.md` (also mirrors the manifest).

## Required disclosures (must appear in listing + settings)

1. The extension scans only after an explicit user action (button press).
2. All processing is local by default; no content leaves the device unless
   cloud analysis is enabled (disabled by default, and no cloud feature ships
   in this version).
3. In-page masks are temporary overlays that do not change the source website.
4. Document redaction downloads a new flattened file; the original is never
   modified or uploaded.
5. The extension stores no raw content and requests no `*://*` host
   permissions.
6. Using the extension does not by itself make a user or organization HIPAA
   compliant.

## Settings screen links

The popup settings section includes:

- **Privacy policy** link → packaged `PRIVACY.md` (opens via
  `chrome.runtime.getURL`); must also be hosted at the canonical public URL
  before submission.
- **Support** link → `https://github.com/ACR-LOGIC/governworld/issues`
- **Export audit log** → signed, metadata-only audit export.

The links are implemented in `src/popup/index.html`; only the canonical
hosted URL remains external (see checklist).

## Screenshots (to capture before submission)

Capture on a **local fixture page** with synthetic data only (the spec's
fixture page, `scripts/make-fixture.mjs` output, or the corpus generator).
Never capture real customer content.

1. Popup closed / extension icon state (1280px or common laptop resolution).
2. Popup open showing the disclosure, mode picker (Local only selected), and
   "Scan this page" button.
3. Findings list with **masked** previews (e.g. `phone: ***-***-1234`), Apply
   masks / Remove masks / Copy redacted text controls.
4. A page with overlay masks applied, showing the footnote that masks are
   temporary.
5. Document review step: a synthetic PDF with detected boxes and the
   "Redact selected & download" button.
6. Download confirmation dialog for the flattened copy.

Requirements for each: no real PII/PHI, no addresses, no URLs with query
parameters visible, no browser chrome identifying real user data, English
text, at least 640x400, PNG or JPEG.

## Store submission checklist

- [x] Manifest is MV3 with least-privilege permissions (`activeTab`,
      `scripting`, `storage`, `downloads`, `offscreen`; no `<all_urls>`).
- [x] Single-purpose description aligned with actual behavior.
- [x] Privacy policy drafted (`PRIVACY.md`), versioned v1.0.0 with support
      contact; pending publication at the canonical URL after push.
- [x] Permission justification drafted (`PERMISSIONS.md`).
- [x] Listing description finalized in `STORE_DESCRIPTION.md` to match the
      enforced local-only behavior and current permissions.
- [x] All fixture/test content synthetic.
- [x] Release packaging tooling: `npm run release:zip` builds from the
      reviewed commit (refuses un-reviewed HEAD) and emits
      `release/governworld-redaction-<commit>.zip` for store submission.
- [x] Manifest description within the 132-character store limit (shortened
      2026-08-21); extension icons (16/32/48/128) added to the manifest and
      packaged in `dist/icons/`.
- [x] Accessibility-surface scan shipped report-only (`source:"attr"`,
      `aria-label`/`alt`/`placeholder`/`title`, DOM never mutated, no raw
      attribute values stored) — disclosed in PRIVACY.md and listing copy.
- [ ] Privacy policy published at the canonical URL and referenced in the
      listing.
- [x] Screenshots captured from a local synthetic fixture page (6 required,
      in `release/screenshots/`).
- [x] Final review that no real PII/PHI appears in any listing asset
      (synthetic fixtures + secret scan; see `RELEASE_EVIDENCE.md`).
- [x] Security review sign-off before submission (APPROVED at `b4c8614`,
      2026-08-22; recorded in `RELEASE_EVIDENCE.md`).
- [x] Commit approved, then generate the release zip from the exact reviewed
      commit and record artifact SHA-256 in `RELEASE_EVIDENCE.md`.
      (`release/governworld-redaction-b4c8614.zip`, SHA-256 recorded.)
- [x] Side panel added (`sidePanel` permission, `Alt+Shift+P`) as a persistent
      scanning/document/account surface.
- [x] Notifications shipped as an **optional** permission (`notifications`),
      requested at runtime only when the user enables the toggle.
- [x] Optional-permission UX: no new permission is required at install.
- [x] Account linking (gateway origin + `gw_` API key) is fail-closed and
      reuses the existing tenant — no onboarding/tenant-provisioning in the
      extension; profile + extension add-on purchase ride the existing
      Stripe checkout/webhook/entitlement plane.
- [x] Developer preset added — API keys & secrets category (OpenAI, Anthropic,
      Google, Stripe, GitHub, Slack, SendGrid, npm, Twilio, Databricks, AWS,
      Azure, private keys, JWTs, connection strings, credential assignments)
      selectable via the Developer preset or Custom.
- [x] Preset behavior: Custom = all checkboxes; HIPAA/PCI/GDPR/Developer
      auto-select their covered categories; unchecking any box reverts the
      preset to Custom.
- [x] Preset transitions are recorded in the signed audit log
      (`preset_applied` / `preset_overridden` with the active category set) so
      reviewers can trace why a category was not redacted.
- [x] One-time "Please verify your work" accuracy notice (pattern-based
      detection is not guaranteed complete) shown after the first scan.
- [x] Instructions section in the side panel (page scanning, keyboard
      shortcuts, side panel, document redaction, accuracy).
- [x] Landing page (`landing.html`, also served at localhost preview root)
      with Overview, Security, Privacy, About Us, and About This Extension
      tabs.
- [x] Optional redaction labels (`maskPlaceholders`): when enabled, applied
      mask blocks show a short white label (e.g. `[SSN]`, `[DOB]`,
      `[API KEY]`) identifying what was covered. Off by default.
- [ ] ⚠️ Release ZIP is **stale** — feature additions landed after `b4c8614`.
      Regenerate `release/governworld-redaction-<commit>.zip` from the new
      approved commit and re-record the artifact SHA-256 before submission.

## Deployment note (gateway adapter, spec step 8)

Step 8 (optional cloud/gateway analysis) is **not implemented** because no
gateway deployment mode exists for the extension — the spec's request
contract is a proposal and no server endpoint implements it. Shipping a live
adapter against a nonexistent backend would be speculative. Consequently the
**Cloud analysis** radio in the popup is disabled, and the service worker
rejects any `POPUP_SET_MODE`/scan attempt with `mode: "cloud"` (fail closed,
deny-by-default) until a gateway is deployed, authenticated, auditable, and
has a defined privacy/compliance posture. The store listing must not claim
cloud analysis exists.

The side-panel **account linking** surface is a distinct, opt-in feature: it
only stores a user-pasted gateway origin + API key for profile display and
Stripe checkout of the extension add-on. It never sends scan content and does
not enable cloud analysis.