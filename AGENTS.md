# AGENTS.md

## Verification (CI parity, in order)

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 59 files / 1097 tests
npm run build       # esbuild → dist/
npx vitest run tests/dist-manifest.test.ts tests/offline-assets.test.ts
npm run sync:sidepanel  # regenerate src/sidepanel/{sidepanel.html,sidepanel.css} from src/popup/
npm run icons      # regenerate icons/ from brand/logo-master.png
npm run test:doc-flow   # Document Studio end-to-end in real Chromium (needs a display)
npm run test:no-text    # a page that is only an image must not report success (needs a display)
npm run test:image-capture  # a textless page offers its image to the studio (needs a display)
npm run test:review    # full-screen review: draw, restyle, redact, download (needs a display)
npm run capture:ui  # Playwright UI walkthrough → screenshots + video (needs a display)
```

- The last two tests are the build-contract gate: they verify every path `manifest.json` resolves and all offline worker assets exist in `dist/`. They **skip silently when `dist/` is absent** — always run them after `npm run build`.
- `tests/*.e2e.spec.ts` (Playwright) are **not** part of `npm test` or CI. They need a persistent Chromium context with the unpacked `dist/` extension plus a fixture server on `localhost:8081`. There is no `playwright.config.ts`; they only run when invoked directly.
- `npm run verify:browser` — requires `npx playwright install chromium` and a prior `npm run build`. Launches **headed** Chromium (`headless: false`), so it needs a display; never run it headless.
- `npm run test:photo-e2e` — full-chain OCR/redaction E2E in real Chromium. Requires `npm run build` and fixtures via `npm run fixtures:photo`.
- `npm run test:doc-flow` — Document Studio journey in real Chromium: pick a PDF, progress appears, findings render, the studio survives a popup reload, redaction completes, a download is produced, and the print view is offered. Requires `npm run build`. It builds the File and dispatches `change` from inside the page instead of using Playwright's `setInputFiles`, which intermittently fails to deliver the event in this environment and reads as a product failure when it is a harness artefact. The redaction is requested with `saveAs: true`, so in automation the download may sit in `in_progress` with nobody to answer the save dialog; the check accepts that and only fails on a missing, errored, or interrupted download.
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
- **The Document Studio must always show its state.** v0.1.0 shipped a document path that processed correctly and looked completely inert: `#doc-status` ships with `hidden` and nothing lifted it, so every status and every error rendered into a `display:none` element; `setDocStatus` also wrote to the wrapper instead of the `#doc-status-text` paragraph the markup provides; `resetDocStages()` hid the progress row and nothing re-showed it during a 6–20s preview; the success path called `renderDocStage()` and left a permanent "Processing document…" spinner with a Cancel button on a finished document; the worker's `{ ok: false, error }` replies were discarded at every call site; and `void initPopup()` swallowed an init rejection, which left the whole popup with markup and no listeners. Therefore: `setDocStatus` writes to `#doc-status-text` and owns `hidden`; a run that is working shows `#doc-progress`, a run that has ended hides it; document messages go through `sendDocMessage`, which surfaces a refusal; and `entry.ts` handles an init rejection. Enforced by `tests/document-studio-feedback.test.ts` and end-to-end by `npm run test:doc-flow`.
- **Staged-document storage is one shared, bounded implementation.** The popup and the service worker must both use `src/shared/docDb.ts`; they previously each carried their own `openDb` and the copies drifted. A cached `IDBDatabase` goes stale (schema upgrade, browser close) and a blocked `indexedDB.open` fires neither `success` nor `error`, so the cached promise stayed pending for the life of the context and every caller awaited it forever — a silent hang with no error anywhere. `openDocDb` is bounded and fails a blocked open fast, `onclose`/`onversionchange` drop the cache, and every operation is bounded and retried once. Never add an unbounded `indexedDB` await, and never reintroduce a second copy of the connection logic.
- **The document session must outlive the popup.** The Document Studio is destroyed whenever the popup loses focus, and MV3 terminates an idle worker after ~30s while `chrome.storage.session` survives, so an in-memory-only session map meant that looking away during a preview lost the document. `previewDocument` persists the session descriptor under `lastDocSession` and `restoreLastSession()` rebuilds the session from the IndexedDB bytes; the popup's `POPUP_DOC_STATE` handler adopts a message when `lastDoc` is null, because the worker is authoritative about which document is current. Never drop that reply.
- **A lifecycle failure must not disable the worker permanently.** The browser-startup purge used to latch `startupCleanupError` on the first failure and never clear it, which rejected *every* later message for the rest of the worker's life. Housekeeping is best-effort: a success clears the flag, and document work waits on a bounded `PURGE_WAIT_MS` so the purge cannot delete a file the user has just staged. A document message must also fail fast and retry once when the offscreen document is reclaimed, because Chrome may destroy it at any time.
- **A page that is an image must route to OCR, and say so.** `extract.ts` reads `node.textContent`, so a page whose content is pixels (a letterhead scan, a rendered PDF, a screenshot) legitimately yields nothing. Two consequences, both enforced. First, honesty: `visibleChars === 0` takes an error branch (`status_no_text_found`), never "Completed securely on-device". Second, a route: the scan reports `stats.imageCandidates` (document-sized images only, capped at 12, each marked `sameOrigin`), and the popup renders one button per image that stages it into the Document Studio through `POPUP_DOC_CAPTURE_IMAGE`. The button colour states the real limit — green for a same-origin image whose original bytes can be read, amber for a cross-origin one that can only be captured from the screen, which OCRs worse. The bytes are either the original file (`src/service-worker/captureImage.ts` → `tryFetchOriginal`) or `chrome.tabs.captureVisibleTab`, never both, and `degraded` follows the choice through to the UI. Enforced by `scripts/verify-no-text-reporting.mjs` and `scripts/verify-image-capture.mjs`.
- **Drawing a redaction box only exists in the full-screen review page.** The popup is a 360px column, so a page of text renders at roughly a tenth of its natural size: the words are unreadable and a box lands on pixels nobody can see. `src/popup/review.html` shows the document at full size with the controls in a side panel, and `renderDoc`'s popup canvas is a thumbnail, not a drawing surface. The review canvas backing store is the page's real `widthPx`/`heightPx` and pointer coordinates are converted into it, so a box is correct at any zoom. Two contracts to preserve: the session is handed over through `chrome.storage.session`, never a message (page metadata exceeds `MAX_MESSAGE_BYTES`), and a drawn box id must start with `custom:` — the worker validates every selected id against the session and only tolerates an unrecognised one with that or a `user:` prefix, so any other prefix is rejected at redaction time with "The selected findings are no longer available." Enforced by `scripts/verify-review-surface.mjs` and `tests/document-studio-feedback.test.ts`.
- **A scan that read nothing must never report success.** The content script reads `node.textContent`, so a page that *is* an image (a letterhead scan, a rendered PDF, a screenshot) legitimately yields zero characters while being full of PII. That case reported "Completed securely on-device" — a clean bill of health for a document nobody read. `visibleChars === 0` now takes a dedicated error branch, `status_no_text_found`, that names the image case and points at OCR. OCR lives only in the Document Studio, so "scan the page" can never find text inside pixels; that is a capability limit, not a bug to paper over. Enforced by `scripts/verify-no-text-reporting.mjs`.
- **i18n dictionary routing:** `t()` reads only `UI_TRANSLATIONS`; `getCategoryLabel()` reads only `CATEGORY_TRANSLATIONS`; `getPresetLabel()` reads only `PRESET_TRANSLATIONS`. Any key used in a `data-i18n` attribute must be added to `UI_TRANSLATIONS` in all 7 languages. Enforced by `tests/i18n-and-accessibility.test.ts`.
- **Synthetic test data only:** RFC 2606 `.test` domains, never-issued SSN (219-09-9999), documented test card 4111111111111111. Never use real PII in fixtures or tests.
- **CSP:** `script-src 'self' 'wasm-unsafe-eval'` — no inline scripts, no remote code, no `eval` outside WASM.

## Settled decisions (do not re-raise as gaps)

These were open questions that have been decided deliberately. Treat them as
settled; changing one is a product decision, not a cleanup.

- **Terms carry no governing-law or venue clause.** Decided: omit it. The
  liability section already limits itself "to the maximum extent permitted by
  applicable law", so the document does not assert a jurisdiction it does not
  have. Do not add a jurisdiction to the Terms without a decision about the
  entity's actual domicile.
- **OCR is English-only by design.** `src/shared/ocrLanguages.ts` is the single
  source of truth for the build, the worker, and the selector, and unbundled
  languages fail closed. Detection is language-agnostic regex, so non-English
  text is still covered for structured identifiers; only image OCR is affected.
  Adding a language is a vendoring decision, not a code change — see
  `docs/ocr-languages.md`.
- **Paste Shield stays on-demand.** The extension declares no host permissions
  and no declarative content scripts, so the guard is absent from any tab the
  user has not activated. This is the intended privacy trade, documented with
  its consequences in README. Always-on protection requires an `optional_host_permissions`
  or `<all_urls>` decision and is out of scope unless explicitly chosen.
- **Community rules are not yet trusted.** Both community network paths are
  stubbed off in the service worker and return an error. Do not enable either
  without working through `docs/community-trust-model.md`, which specifies
  publisher-key pinning, signed packs, fail-closed verification, and the
  additive-only rule invariants. The input validation and contribution screening
  in `src/shared/customPatterns.ts` are defence-in-depth for a disabled path, not
  a live control.

## Environment

- Node.js 20+, npm 10+. Targets: Chrome 116+, Firefox 109+.
- Release packaging: `npm run release:zip <sha>` (`scripts/make-release.mjs`). It
  takes the commit SHA explicitly and refuses a dirty tree or a HEAD that does
  not match, so only reviewed content is ever packaged.
- **Housekeeping:** `npm run clean` reports superseded release archives and test
  scratch directories; `npm run clean:apply` deletes them. Every packaging
  iteration otherwise leaves a 14 MB archive pair behind, and several of them
  are marked do-not-submit in `RELEASE_EVIDENCE.md` - so uploading the wrong one
  is a live risk, not just wasted disk. The script only deletes an archive whose
  commit is still in the repository, so anything reproducible is safe to remove
  and anything else is kept and reported.
- `npm run verify:digests` re-checks every digest recorded in
  `RELEASE_EVIDENCE.md` against the committed blob, and runs in CI.
