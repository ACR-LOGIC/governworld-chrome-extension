# AGENTS.md

## Verification (CI parity, in order)

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 36 files / 601 tests
npm run build       # esbuild → dist/
npx vitest run tests/dist-manifest.test.ts tests/offline-assets.test.ts
```

- The last two tests are the build-contract gate: they verify every path `manifest.json` resolves and all offline worker assets exist in `dist/`. They **skip silently when `dist/` is absent** — always run them after `npm run build`.
- `tests/*.e2e.spec.ts` (Playwright) are **not** part of `npm test` or CI. They need a persistent Chromium context with the unpacked `dist/` extension plus a fixture server on `localhost:8081`. There is no `playwright.config.ts`; they only run when invoked directly.
- `npm run verify:browser` — requires `npx playwright install chromium` and a prior `npm run build`. Launches **headed** Chromium (`headless: false`), so it needs a display; never run it headless.
- `npm run test:photo-e2e` — full-chain OCR/redaction E2E in real Chromium. Requires `npm run build` and fixtures via `npm run fixtures:photo`.
- `npm run test:offline-ocr` — smoke test that Tesseract runs from `dist/assets` with no network. Requires `npm run build` first.

## Build

`npm run build` (esbuild via `build.mjs`) bundles five entry points with **different formats**: service worker and offscreen document are ESM; content script, popup, and sidepanel are IIFE. HTML/CSS is copied, not bundled.

- The build **fails closed** without `vendor/tessdata/eng.traineddata.gz` — it is vendored on purpose. Never delete it.
- pdf.js worker, tesseract worker/core/wasm, and tessdata are copied into `dist/assets/` and loaded via `chrome.runtime.getURL`. The document pipeline must never fetch OCR/PDF assets from the network.
- `dist/` is gitignored; `tests/dist-manifest.test.ts` skips without it.
- Icons are generated deterministically — regenerate with `node scripts/make-icons.mjs`, never hand-edit `icons/`.

## Architecture

- `src/service-worker/index.ts` — MV3 ES-module service worker; sole orchestrator. Validates every incoming message (`src/shared/messages.ts`) before acting. Scan sessions live in `chrome.storage.session` (key `scan:<tabId>`).
- `src/content/content.ts` — IIFE content script, injected only via `activeTab` after explicit user action. Guarded by `globalThis.__gwRedactionContentLoaded`. Page DOM is read-only; masks render in a shadow-root overlay.
- `src/offscreen/offscreen.ts` — ES-module offscreen document hosting pdf.js + tesseract WASM. Communicates with the service worker via the message contract in `src/document-pipeline/contract.ts` (`OFFSCREEN_CHANNEL`). **Binary payloads must be base64-encoded** — extension messaging is JSON-serialized.
- `src/shared/` — cross-context code: `messages.ts` (message validation), `settings.ts`, `audit.ts` (ECDSA-signed, fail-closed), `i18n.ts`, `wizardAnalyzer.ts`, `customPatterns.ts`, `types.ts`.
- `src/api/` — cloud API client. All cloud features are **disabled and locked by default**; do not wire them into user flows without an explicit decision.
- Detection logic: `src/validators/index.ts` (checksum validators) and `src/content/detect.ts` (regex/category detectors). New patterns require unit tests.

## Invariants (enforced by tests)

- **Local-first / zero egress:** no raw page text, document bytes, or unmasked values may be transmitted. Never add `host_permissions` (`*://*` or domain wildcards).
- **Fail-closed audit:** any redaction/policy/document operation must write an ECDSA-signed audit record (`src/shared/audit.ts`).
- **UI tab contract:** popup (`src/popup/index.html`) and sidepanel (`src/sidepanel/sidepanel.html`) must keep the five tabs `scanner`, `documents`, `wizard`, `settings`, `instructions` with matching `data-tab` / `id="tab-..."` attributes and all required guide sections. Enforced by `tests/instructions-and-guidance.test.ts`.
- **Synthetic test data only:** RFC 2606 `.test` domains, never-issued SSN (219-09-9999), documented test card 4111111111111111. Never use real PII in fixtures or tests.
- **CSP:** `script-src 'self' 'wasm-unsafe-eval'` — no inline scripts, no remote code, no `eval` outside WASM.

## Environment

- Node.js 20+, npm 10+. Targets: Chrome 116+, Firefox 109+.
- Release packaging: `npm run release:zip` (`scripts/make-release.mjs`).
