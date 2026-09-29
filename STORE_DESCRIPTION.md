# GovernWorld Redaction — Store Description

Draft listing copy for the Chrome Web Store. Uses synthetic examples only.
Review before submission; final copy lives here until pasted into the store
listing.

## Short summary

Find and redact sensitive values (phone numbers, email addresses, payment
card numbers, API keys and secrets, and other identifiers) in the page you are
viewing and the documents you open — processed locally on your device.

## Full description

**GovernWorld Redaction** finds sensitive values in the visible text of the
page you are viewing and in the PDF, image, and Word files you open, then lets
you cover them up:

- **Scan on demand.** Nothing scans automatically. Open the popup and press
  **Scan this page** to analyze the visible text of the current tab.
- **Local only — enforced.** This version is strictly local. Scanning,
  detection, OCR, and redaction all run on your device. Your page text and
  documents never leave your device.
- **Review, then act.** Findings are listed with masked previews (for example,
  `phone: ***-***-1234`). Choose what to cover.
- **Temporary page masks.** Masks are an on-screen overlay only. They do not
  change or store anything on the website you are viewing. Optionally, masks
  can show the category they covered (e.g. `[SSN]`, `[API KEY]`).
- **Copy redacted text.** Get a copy of the page text with sensitive values
  replaced by solid blocks, after your explicit confirmation.
- **Preset policies.** HIPAA, PCI DSS, GDPR, and Developer (API keys &amp;
  secrets) presets auto-select the categories they cover; unchecking any
  category reverts to Custom, and the change is recorded in the signed audit
  log.
- **Side panel.** Keep scanning, document redaction, notifications, and
  account/license controls open while you browse (`Alt+Shift+P`).
- **Accessibility-surface check (report-only).** The scan also looks in
  `aria-label`, `alt`, `placeholder`, and `title` attributes — places screen
  readers read but you may not see. Findings there are reported with a masked
  preview only; the extension never changes a page's attributes.
- **Redact documents locally.** Open a PDF, image, or Word document, review the
  detected values on each page, and download a **new flattened copy** with the
  values covered in black. The original file is never modified or uploaded.
- **Signed audit log.** Every scan, mask, document, and preset change is
  recorded as metadata-only, tamper-evident, ECDSA-signed audit entries.

**Privacy by design.**

- No `*://*` host permissions. No background scanning, keystroke capture, or
  network monitoring. The extension asks only for `activeTab`, `scripting`,
  `storage`, `downloads`, `offscreen`, `sidePanel`, and `contextMenus` (plus an
  optional, runtime-requested `notifications` permission) — each mapped to a
  specific, user-triggered feature.
- No raw scanned text, document bytes, or page images are stored, logged, or
  transmitted. Temporary state is cleared when your browser restarts.
- Optional account linking (a gateway origin + API key you paste) is used only
  for profile display and extension add-on checkout — never for scan content.
- Privacy policy:
  https://governworld.acrlogic.com/chrome-extension-privacy

**A note on compliance.** This extension helps you redact sensitive values,
but using it does not by itself make you or your organization HIPAA or
otherwise compliant. You remain responsible for your compliance obligations.

## Single purpose

Find and redact sensitive values in content the user explicitly chooses to
scan. The extension does not change behavior based on which website is open.

## Permissions at a glance (from the manifest)

- `activeTab` — scan only the page you are viewing, only after you press a
  button.
- `scripting` — inject the scanning/masking code into that page after your
  action.
- `storage` — remember your settings and temporary scan state.
- `downloads` — save the flattened redacted document you create.
- `offscreen` — run document OCR and rendering in a dedicated offscreen
  document.
- `sidePanel` — show the side panel for scanning, document redaction,
  notifications, and account/license management.
- `contextMenus` — add "Scan page for sensitive data", "Redact selection to
  clipboard", and "Mask selected text / element" to the right-click menu, so
  the same on-demand actions can be started from there. Each entry runs only
  when you click it, and the entries can be switched off in settings.
- `notifications` (optional, requested at runtime) — scan-findings notice only
  after you enable it.

See `PERMISSIONS.md` for the full justification.