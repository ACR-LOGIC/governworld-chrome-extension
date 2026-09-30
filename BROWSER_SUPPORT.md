# GovernWorld — Browser Support & Coverage Boundary

Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

Code is the authority. This document describes what the implementation does;
where it says "pending", the feature is not claimed anywhere else either
(enforced by `tests/claims-accuracy.test.ts`).

## Browser identity matrix

| Browser | Platform | Extension ID | Artifact | Status |
|---|---|---|---|---|
| Chrome | Chromium | n/a (Web Store identity) | `GovernWorld-Chromium-v<V>-<sha>.zip` | Shipped target |
| Edge | Chromium | shared Chromium package | same Chromium artifact | Compatible (same build) |
| Brave / Opera / Vivaldi / Arc | Chromium | shared Chromium package | same Chromium artifact | Compatible, not QA-run |
| Firefox | Gecko | `redaction@governworld.acrlogic.com` (locked) | `GovernWorld-Firefox-v<V>-<sha>.zip` | Packaged (`npm run build:firefox`); browser-run QA pending |
| Safari (macOS) | WebKit | assigned at packaging time by Apple tooling | none claimed | Blocked (see below) |
| Safari (iOS) | WebKit | assigned at packaging time by Apple tooling | none claimed | Blocked (see below) |

The Firefox ID is locked in `manifest.firefox.json` and asserted by
`tests/firefox-manifest.test.ts`. It must never be regenerated: changing it
after publication breaks upgrades. The Chromium `manifest.json` carries the
same gecko block so the two packages never claim different identities.

## What each target runs

One deterministic engine (`src/content/detect.ts`, validators, paste guard,
scan/normalization), three packages:

- **Chromium** (`npm run build` → `dist/`): everything — page scan, masks,
  paste modes incl. always-on, Document Studio (offscreen pdf.js + tesseract),
  side panel, context menus, enterprise managed policy via
  `storage.managed_schema` (`schema/policy.json`).
- **Firefox** (`npm run build:firefox` → `dist-firefox/`): MV3 manifest with
  event-page background (`background.scripts`, Firefox runs MV3 background
  contexts as documents), `sidebar_action` panel, same content/UI bundles,
  same optional http(s) site access for always-on
  (`scripting.registerContentScripts` exists on Firefox; the code
  capability-detects it). **Document Studio is tier-limited**: Firefox has no
  `chrome.offscreen` API, so document jobs fail fast with the explicit message
  in `src/shared/platform.ts` instead of stalling. Page scanning, masks, and
  paste protection are unaffected.
- **Safari** (`npm run build:safari` → `dist-safari/`): handoff payload only.
  The always-on, enterprise-policy, and offscreen paths are all
  capability-gated in code, so the payload degrades honestly on Safari
  (always-on reports "waiting for access", policy reads unmanaged, documents
  report the offscreen limitation). No distributable Safari artifact is
  produced or claimed here.

## Protection modes and the permissions that make them real

| Mode | What it means | Minimum permission | New tabs | Restart | Navigation |
|---|---|---|---|---|---|
| Off | No interception; explicit scans still work | none | n/a | persists (setting) | n/a |
| This tab (default) | Guard in tabs explicitly authorized via the extension action, shortcut, or menu | `activeTab` (one-time, per invocation) | not covered until authorized | not covered until authorized | SPA navigation stays covered (script persists, observer keeps watching); full reloads need re-authorization |
| Always on | Guard on every visited http(s) page | optional `http://*/*` + `https://*/*`, granted at runtime, revocable | covered via persisted registration | re-armed on worker start | covered, including SPA views |

The UI reports `always-on-active` only with proof (registration API present
**and** the grant still held). Any other combination reads "waiting for
access". Revoking the grant removes the registration (`syncSiteProtection`),
so revocation genuinely stops coverage.

## Per-surface coverage (Chromium, this-tab or armed always-on)

| Surface | Covered | How |
|---|---|---|
| `input` / `textarea` paste (keyboard, menu, programmatic clipboard) | yes | `paste` event, capture phase, synchronous `preventDefault` before insertion |
| `contenteditable` paste | yes | same path |
| `beforeinput` `insertFromPaste` / `insertFromDrop` | yes | backstop where the engine exposes data (most engines expose none here) |
| drag-and-drop text (`drop`) | yes | `drop` event, same decision path |
| rich-text editors (dynamically created) | yes | MutationObserver attaches to added subtrees |
| open shadow-DOM editors | yes | listeners attached to every reachable open shadow root |
| same-origin iframes | yes | `allFrames: true` registration; same-document traversal as backstop |
| cross-origin iframes | **no** | platform boundary: the extension cannot see inside. Documented, not absorbed |
| programmatic `input.value = …` by page script | **no** | not an input event; nothing to intercept. Documented |
| synthetic `insertText` / autocorrect / autofill running outside paste/drop | partial | intercepted only when they surface as paste/drop events; otherwise documented |
| SPA navigation | yes | script persists; observer covers new editors |
| full navigation / new tab / restart (this-tab) | re-authorize | `activeTab` grants do not survive these by platform design |
| `file://`, `chrome://`, Web Store pages | no | extensions cannot run content scripts there by platform design |

## Mobile boundary

A Safari Web Extension governs supported browser activity **inside Safari**
only. It does not govern iMessage, native ChatGPT/Claude/Gmail apps, other
iOS applications, or the OS. "GovernWorld governs the entire iPhone" is
incorrect and is not claimed anywhere.

## Safari packaging blocker (exact)

Producing an installable Safari extension from `dist-safari/` requires one of:

1. A Mac with Xcode: `xcrun safari-web-extension-packager dist-safari`
   (the renamed `safari-web-extension-converter`), then build/run the
   generated app project; or
2. App Store Connect's web-based Safari web extension packager (any browser,
   Apple Developer Program membership required; Xcode Cloud compute applies).

Distribution additionally requires signing (App Store or notarized direct
download) under the Apple Developer Program. None of this is available on the
current Windows build machine, so Phase 6 ends at the verified handoff
payload. The first Safari QA run must cover: popup, content-script injection,
paste interception on a real page, and the three capability-degraded paths
(always-on status, unmanaged policy, document error).

## Test matrix (honest status)

Unit + happy-dom enforcement suites run in CI on every commit
(`tests/paste-enforcement.test.ts`, `tests/protection-modes.test.ts`,
`tests/platform-capabilities.test.ts`, `tests/firefox-*.test.ts`).
Browser-run matrix (Chrome headed, Firefox `about:debugging`, Safari):

| Test | Chrome | Edge | Firefox | Safari |
|---|---|---|---|---|
| Paste PHI / PII / API key blocked pre-insertion | unit-proven, browser run pending | — | — | — |
| Safe paste untouched | unit-proven, browser run pending | — | — | — |
| Contenteditable / dynamic input / shadow DOM | unit-proven, browser run pending | — | — | — |
| Drop interception | unit-proven, browser run pending | — | — | — |
| Unknown-AI hostname surface | unit-proven, browser run pending | — | — | — |
| OFF allows paste | unit-proven | — | — | — |
| Always-on grant → new-tab coverage | pending | pending | pending | pending |
| Enterprise lock not overridable | unit-proven, browser run pending | — | — | — |
| Document Studio (Chromium) | existing E2E (`test:doc-flow`) | — | n/a (explicit error) | n/a (explicit error) |

No cell is marked PASS without an actual run. "Unit-proven" means the
enforcement logic is tested against a real DOM in happy-dom; headed-browser
runs remain to be recorded.
