# Contributing to GovernWorld Chrome Extension

Thank you for your interest in contributing to the GovernWorld Chrome Extension! We welcome community contributions, bug reports, feature enhancements, and community sponsorship.

---

## 💛 100% Free, Local-First & Community Supported

GovernWorld is built on an uncompromising commitment to privacy:
* **100% Local-First:** All scanning, OCR, pattern matching, and document flattening happen on your local device.
* **Zero Data Monetization:** We never sell, track, monetize, or transmit user data or document contents.
* **Completely Free:** Every core protection capability is free for everyone.

### Sponsoring Development
If GovernWorld helps protect your privacy or workflow, you can support ongoing maintenance, offline OCR models, and validator improvements by sponsoring via Buy Me a Coffee:

☕ **[Support GovernWorld on Buy Me a Coffee](https://buymeacoffee.com/governworld)** (`https://buymeacoffee.com/governworld`)

---

## Ways to Contribute

1. **Submit New Detection Patterns & Validators:**
   - Add algorithmic checksums or regex definitions to [`src/validators/index.ts`](src/validators/index.ts) or [`src/content/detect.ts`](src/content/detect.ts).
   - Author and share custom rules created in the Redaction Wizard.
2. **Improve Document & Visual Redaction:**
   - Enhance PDF, Word (DOCX), or image canvas processing pipelines under [`src/document-pipeline/`](src/document-pipeline/).
3. **Enhance UI & Accessibility:**
   - Improve keyboard navigation, high-contrast themes, and screen reader labels.
4. **Report Bugs & Suggest Features:**
   - Open an issue on our [GitHub Issue Tracker](https://github.com/ACR-LOGIC/governworld-extension/issues).
5. **Financial Sponsorship:**
   - Support development at [buymeacoffee.com/governworld](https://buymeacoffee.com/governworld).

---

## Development Workflow

### Prerequisites
- Node.js 20+
- npm 10+
- Google Chrome (or Chromium-based browser)

### Setup & Local Development
1. Clone this repository:
   ```bash
   git clone https://github.com/ACR-LOGIC/governworld-extension.git
   cd governworld-chrome-extension
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   npm run build
   ```
4. Run tests:
   ```bash
   npm test
   ```
5. Typecheck:
   ```bash
   npm run typecheck
   ```
6. Run browser end-to-end photo redaction benchmark:
   ```bash
   npm run test:photo-e2e
   ```

### Loading in Chrome
1. Navigate to `chrome://extensions/` in Chrome.
2. Toggle **Developer mode** in the upper right corner.
3. Click **Load unpacked** and select the `dist/` directory inside this repository.
4. Pin the extension to your toolbar.

---

## Architecture & Privacy Invariants

- **Local-First Invariant:** No feature may send raw page text, document bytes, or unmasked sensitive values across the network. All detection and redaction must execute on-device.
- **Zero Host Permissions:** Do not add broad host permissions (`*://*` or domain-specific wildcards). All tab interactions must occur through explicit user action (`activeTab`).
- **Fail-Closed Audit:** Any operation affecting redaction policies or document outputs must generate an immutable, ECDSA-signed audit record.
- **Clean Code & Testing:** Every new detection pattern or feature must include unit tests under `tests/` and maintain 100% test pass rates.
