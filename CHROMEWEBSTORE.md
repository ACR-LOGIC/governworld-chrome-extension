# Chrome Web Store Listing — GovernWorld Redaction

> **Last Updated:** 2026-09-27  
> **Extension Name:** GovernWorld Redaction  
> **Extension Version:** 0.1.1  
> **Target Manifest Version:** Manifest V3  
> **Status:** Ready for Submission

---

## 1. Store Listing Details

### Product Details
- **Name:** GovernWorld Redaction
- **Summary (up to 132 chars):** Local-first PII/PHI detection and redaction for pages and documents. On-device processing keeps your data private.
- **Category:** Productivity / Privacy & Security
- **Language:** English (United States)

### Detailed Description
**GovernWorld Redaction** finds sensitive values in the visible text of the page you are viewing and in the PDF, image, and Word files you open, then lets you redact or mask them directly on your device:

- **Scan on demand.** Nothing scans automatically. Open the popup or side panel and press **Scan this page** to analyze the visible text of the current tab.
- **Local only — enforced.** Scanning, detection, OCR, and redaction all run on your device. Your page text and documents never leave your device, and the local pipeline has no network path at all. The optional account-linking feature contacts GovernWorld for billing metadata only; it is off until enabled and never carries scan content.
- **Review, then act.** Findings are listed with masked previews (for example, `phone: ***-***-1234`). Choose what to cover.
- **Temporary page masks.** Masks are an on-screen overlay only. They do not change or store anything on the website you are viewing.
- **Preset policies.** HIPAA, PCI DSS, GDPR, and Developer (API keys & secrets) presets auto-select the categories they cover.
- **Custom Redaction Wizard.** Step-by-step wizard to define custom regex, test against live sample text, and activate custom detection rules locally.
- **Document Processing.** Open a PDF, image, or Word document, review detected values, and download a flattened, securely redacted copy.
- **Dedicated Instructions & Deep Links.** Comprehensive documentation with contextual in-app guidance jumping straight to relevant instruction cards.
- **Signed audit export.** Every scan, mask, document, and preset change is recorded as a metadata-only audit entry, and exported logs are ECDSA-signed so an edit to an export is detectable. The signature proves the export was produced by this extension and has not been altered since; it does not prove the log is a complete history.

---

## 2. Permissions Justification

Every permission declared in `manifest.json` is strictly required for core local functionality:

| Permission | Category / Justification |
| :--- | :--- |
| `activeTab` | Required to access and scan the active tab's visible text solely upon direct user action (clicking "Scan this page"). |
| `scripting` | Required to inject the local scanning script and display non-destructive masking overlays in the active tab upon user request. |
| `storage` | Required to store user configuration, custom redaction rules, preset selections, and local signed audit records on the device. |
| `downloads` | Required to save locally flattened and redacted document files (PDFs/images) directly to the user's download directory. |
| `offscreen` | Required to execute CPU-intensive local OCR extraction (Tesseract.js) and PDF canvas rendering in an isolated offscreen context without stalling UI responsiveness. |
| `sidePanel` | Required to provide a persistent side panel interface (`Alt+Shift+P`) for document scanning, live wizard rule creation, and in-depth instruction viewing. |
| `contextMenus` | Required to add three on-demand entries to the browser context menu — "Scan page for sensitive data", "Redact selection to clipboard", and "Mask selected text / element" — so the same user-initiated actions can be started from a right-click. The entries are created only while the setting is enabled and are removed when it is disabled, and each still runs the existing click-to-scan path. |
| `notifications` *(optional)* | Requested only if the user explicitly opts into a desktop notification when a scan finds sensitive data. |

### Host Permissions Justification
- **Zero Host Permissions:** The extension declares no `host_permissions` and does not automatically access or communicate with any remote origin.

---

## 3. Privacy & Data Use Disclosures

- **Single Purpose:** Provide local-first detection and redaction of sensitive data in web pages and local files.
- **Remote Code:** The extension does NOT execute remote code or download scripts dynamically. All scripts and WebAssembly modules are bundled locally within the extension.
- **Data Collection:** The extension collects **NO user data, NO page content, and NO document bytes**. Everything remains strictly on the local machine.
- **Privacy Policy:** Published at
  https://governworld.acrlogic.com/chrome-extension-privacy (the extension's own
  Chrome Extension Privacy Notice). The same policy ships inside the package as
  `privacy.html` and is linked from the extension's settings section. The Terms &
  Conditions ship as `legal.html` in the same place.

---

## 4. Version History

- **0.1.0 (2026-09-27):** Initial release featuring local-first detection engine,
  document scanning & redaction, interactive Redaction Wizard, 10-part instruction
  suite with deep linking, zero host permissions, and locked API-ready cloud
  integration boundary.

  GovernWorld is released under the **GovernWorld Source-Available Community
  License**. It is source-available and is *not* an OSI-approved open-source
  licence, so this listing describes it as free rather than as open source. The
  third-party libraries it builds on (pdf.js, Tesseract, tesseract.js, pdf-lib,
  and mammoth) are separately licensed under Apache-2.0, MIT, and BSD-2-Clause
  and are credited in the extension's About page.
