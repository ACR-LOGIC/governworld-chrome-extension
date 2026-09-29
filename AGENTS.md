# AGENTS.md

## Verification (CI parity, in order)

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 49 files / 824 tests
npm run build       # esbuild → dist/
npx vitest run tests/dist-manifest.test.ts tests/offline-assets.test.ts
npm run sync:sidepanel  # regenerate src/sidepanel/{sidepanel.html,sidepanel.css} from src/popup/
npm run icons      # regenerate icons/ from brand/logo-master.png
npm run capture:ui  # Playwright UI walkthrough → screenshots + video (needs a display)
```

- The last two tests are the build-contract gate: they verify every path `manifest.json` resolves and all offline worker assets exist in `dist/`. They **skip silently when `dist/` is absent** — always run them after `npm run build`.
- `tests/*.e2e.spec.ts` (Playwright) are **not** part of `npm test` or CI. They need a persistent Chromium context with the unpacked `dist/` extension plus a fixture server on `localhost:8081`. There is no `playwright.config.ts`; they only run when invoked directly.
- `npm run verify:browser` — requires `npx playwright install chromium` and a prior `npm run build`. Launches **headed** Chromium (`headless: false`), so it needs a display; never run it headless.
- `npm run test:photo-e2e` — full-chain OCR/redaction E2E in real Chromium. Requires `npm run build` and fixtures via `npm run fixtures:photo`.
- `npm run test:offline-ocr` — smoke test that Tesseract runs from `dist/assets` with no network. Requires `npm run build` first.
- `npm run capture:ui` — drives the built extension through a 23-step journey and writes screenshots, webm video and `report.json` to `.tmp-ui-session/` (gitignored). It loads a **throwaway** extension copy under `.tmp-ui-session/ext` that adds a localhost-only `host_permissions` entry, because a live page scan is otherwise impossible: `dist/` ships with no host permissions by design and `activeTab` needs a real toolbar gesture that automation cannot synthesise. The script asserts `dist/manifest.json` has no `host_permissions` before building the variant and never writes to `dist/`.
- `capture:ui` exercises mask application on the page. The worker's tab resolver filters extension URLs out but then falls back to the focused tab, so the harness must keep the **fixture** as the active tab: it clicks through the popup's own DOM with `el.click()` rather than `page.click()`, which would focus the popup tab and make the worker look for a scan session that belongs to the popup. Assertions check the mask count inside the content script's shadow root (`div[data-gw-scan-overlay]`), not the light DOM.

## Build

`npm run build` (esbuild via `build.mjs`) bundles five entry points with **different formats**: service worker and offscreen document are ESM; content script, popup, and sidepanel are IIFE. HTML/CSS is copied, not bundled.

- The build **fails closed** without `vendor/tessdata/eng.traineddata.gz` — it is vendored on purpose. Never delete it.
- pdf.js worker, tesseract worker/core/wasm, and tessdata are copied into `dist/assets/` and loaded via `chrome.runtime.getURL`. The document pipeline must never fetch OCR/PDF assets from the network.
- `dist/` is gitignored; `tests/dist-manifest.test.ts` skips without it.
- Icons are generated deterministically from `brand/logo-master.png` by `node scripts/make-icons.mjs`; never hand-edit `icons/`. The emblem is composited whole onto a rounded navy tile — a square crop cannot keep the orbital rings without clipping them, because the emblem is 899x707 and the wordmark starts 11px below it. `scripts/logo-measure.mjs` reprints the measured geometry if the master is ever replaced.
- The brand mark everywhere else is `icons/icon-128.png` referenced from markup, not an inline SVG. A drawn stand-in is a second, different logo.
- **OCR text and token offsets share one implementation.** `src/document-pipeline/offsets.ts` owns both `assembleOcrText` (what detection runs over) and `tokenSpans` (how a match maps back to page rectangles). This rule used to be written out twice, in `ocr.ts` and `core.ts`, kept in sync only by a comment. When tesseract.js 7 was upgraded, `ocr.ts` started returning Tesseract's own `data.text` — different spacing — and every unit test passed while redaction boxes were drawn over content that was never detected. Only the pixel-level photo E2E caught it. Never reintroduce a second copy of the separator rule. Enforced by `tests/ocr-token-offsets.test.ts`.
- **tesseract.js does not return blocks by default.** `recognize()` must be called with `{ blocks: true, text: true }` and the result walked as `blocks -> paragraphs -> lines -> words`. Without the option, `data.blocks` is null, recognition "succeeds", and the pipeline reports zero tokens — a silent failure that typechecking cannot catch. `npm run test:offline-ocr` asserts the traversal, and it is proven to fail when the option is removed.
- **The print/PDF view redacts nothing.** Pipeline: action click → service worker injects and extracts the DOM → session payload (metadata + masked previews only) → offscreen render/OCR/detect → boxes painted and pixel-verified → redacted pages staged in the shared store → `redact.html` renders them → `window.print()` (printer, or Chrome's own "Save as PDF"). `redact.html` is a pure renderer on purpose: a redaction applied at print time could not be verified, and a failed one would reach the printer looking clean. It uses `window.print()` deliberately — `chrome.printing` is enterprise-policy-gated and `chrome.debugger` would add a permission to a tool that exists to protect sensitive data. Pages travel by store key, never in a message. Enforced by `tests/print-pipeline.test.ts` and `npm run verify:print`.
- Document pages carry a real point size. `loadImagePage` converts pixels at 96 DPI; it used to return `widthPt: 0`, which is not a valid page size and made the print view reject every image document.

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
- **UI tab contract:** popup (`src/popup/index.html`) and sidepanel (`src/sidepanel/sidepanel.html`) must keep the four tabs `protection`, `logic`, `review`, `settings` with matching `data-tab` / `id="tab-..."` attributes. Settings is a sub-navigation of eight pages (`profile`, `protection`, `detection`, `appearance`, `notifications`, `privacy`, `advanced`, `about`) using `data-settings-page`; the guide cards live on the `about` page, so any `[data-guide]` help link must call `switchSettingsPage("about")` before scrolling. Enforced by `tests/instructions-and-guidance.test.ts`.
- **Popup/sidepanel ID parity:** every `id` in the popup must exist in the sidepanel (except `gwshield-*` and `open-side-panel-btn`). `src/sidepanel/sidepanel.html` is **generated** from `src/popup/index.html` by `npm run sync:sidepanel` (`scripts/sync-sidepanel.mjs`), which rewrites `popup.css` → `sidepanel.css`, `popup.js` → `sidepanel.js`, and collapses the popup's category-list block to the sidepanel's `<legend>` form. `src/sidepanel/sidepanel.css` is a byte-for-byte copy of `src/popup/popup.css`. **Never hand-edit the sidepanel** — the transform is the contract, and copying the block across by hand silently reintroduces whitespace drift. `npm run sync:sidepanel:check` exits non-zero on drift, so it belongs in CI. Enforced by `tests/frontend-accessibility-and-controls.test.ts` and `tests/popup-dom-contract.test.ts`.
- **Legal pages ship, and are reachable:** `src/popup/privacy.html` and `src/popup/legal.html` are standalone documents (not part of the `UI_TRANSLATIONS` dictionary, and not loaded through `popup.ts`), so nothing type-checks them into existence. Both must be listed in `build.mjs`'s copy step, in `scripts/verify-browser.mjs`'s `EXTENSION_PAGES`, and in the `EXTENSION_PAGES` arrays of `tests/mv3-compliance.test.ts` and `tests/cross-browser-compatibility.test.ts`. Their popup entry points are `href="#"` anchors resolved at runtime via `chrome.runtime.getURL` — a link that is never rewritten is a dead link, and `tests/legal-page.test.ts` asserts the assignment. Legal copy must not overclaim: optional cloud analysis exists and is disabled by default, so the pages may not claim content "never" leaves the device. Enforced by `tests/legal-page.test.ts`.
- **No orphaned DOM references:** every ID `popup.ts` queries must exist in both markups (`#sr-announcements` is the sole exception — it is created on demand), IDs must be unique per page, every class in the markup (plus the ones `popup.ts` creates at runtime: `finding`, `finding__check`, `finding__severity`, `doc-thumb-wrapper`, `doc-thumb-canvas`) must have a CSS rule, and `popup.css` must contain no dead class selectors. A handler wired to a deleted element passes the build and the unit tests while the feature is unreachable. Enforced by `tests/popup-dom-contract.test.ts`.
- **Dead CSS:** `node --experimental-strip-types scripts/prune-dead-css.mts --check` reports rules whose class selectors match nothing. Run it (without `--check` to rewrite) after renaming a class in the markup. A selector part is only satisfiable if **every** class it requires exists, so `.live .dead` is dead too. Do not hand-edit the stylesheet to prune it.
- **No oversized runtime messages:** every message crossing a `chrome.runtime` boundary is bounded by `MAX_MESSAGE_BYTES` (64 KB) and `validateMessage` drops the *whole* message when it exceeds that, with no error surfaced to the UI. Never inline page images, base64 blobs or file bytes in a message. Document page previews are written to the shared store by the offscreen document and referenced by key (`DocPageMeta.previewKey`, `previewKey()` in `src/shared/docStore.ts`); the popup resolves it with `previewObjectUrl()`. Enforced by `tests/doc-preview-transport.test.ts`.
- **`[hidden]` must stay authoritative:** the UA rule `[hidden] { display: none }` is overridden by any class-level `display`, so `popup.css` carries an explicit `[hidden] { display: none !important; }`. Do not remove it — collapsed panels (results, document studio, progress, status, settings sub-pages) would otherwise render permanently visible.
- **i18n dictionary routing:** `t()` reads only `UI_TRANSLATIONS`; `getCategoryLabel()` reads only `CATEGORY_TRANSLATIONS`; `getPresetLabel()` reads only `PRESET_TRANSLATIONS`. Any key used in a `data-i18n` attribute must be added to `UI_TRANSLATIONS` in all 7 languages. Enforced by `tests/i18n-and-accessibility.test.ts`.
- **Synthetic test data only:** RFC 2606 `.test` domains, never-issued SSN (219-09-9999), documented test card 4111111111111111. Never use real PII in fixtures or tests.
- **CSP:** `script-src 'self' 'wasm-unsafe-eval'` — no inline scripts, no remote code, no `eval` outside WASM.

## Environment

- Node.js 20+, npm 10+. Targets: Chrome 116+, Firefox 109+.
- Release packaging: `npm run release:zip` (`scripts/make-release.mjs`).
