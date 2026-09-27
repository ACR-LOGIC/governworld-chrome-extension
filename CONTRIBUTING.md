# Contributing to GovernWorld Chrome Extension

Thank you for your interest in contributing to the GovernWorld Chrome Extension! We welcome community contributions, bug reports, and enhancements.

## Development Workflow

### Prerequisites
- Node.js 20+
- npm 10+
- Google Chrome (or Chromium-based browser)

### Setup & Local Development
1. Clone this repository:
   ```bash
   git clone https://github.com/ACR-LOGIC/governworld-chrome-extension.git
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

### Loading in Chrome
1. Navigate to `chrome://extensions/` in Chrome.
2. Toggle **Developer mode** in the upper right corner.
3. Click **Load unpacked** and select the `dist/` directory inside this repository.
4. Pin the extension to your toolbar.

## Architecture Guidelines
- **Local-First Invariant:** No feature may send raw page text, document bytes, or unmasked sensitive values across the network. All detection and redaction must execute on-device.
- **Zero Host Permissions:** Do not add broad host permissions (`*://*` or domain-specific wildcards). All tab interactions must occur through explicit user action (`activeTab`).
- **Fail-Closed Audit:** Any operation affecting redaction policies or document outputs must generate an immutable, ECDSA-signed audit record.
- **Clean Code & Testing:** Every new detection pattern or feature must include unit tests under `tests/` and maintain 100% test pass rates.
