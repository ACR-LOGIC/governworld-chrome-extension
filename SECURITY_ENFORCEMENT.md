# GovernWorld — Security Enforcement Model

Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

The enforcement boundary, exactly as implemented:

> **When a user attempts to move sensitive data through a protected browser
> input, GovernWorld makes the policy decision before the destination
> receives that data.**

## The pipeline

```text
Clipboard / drag source
   ↓
Browser input event (paste | beforeinput | drop), capture phase
   ↓
Local detection (deterministic regex + checksum validators, on-device)
   ↓
Policy decision (mode + categories + enterprise lock, all local)
   ↓
ALLOW (no findings, or mode off) | SANITIZE (user picks Sanitize & Paste)
   | BLOCK (preventDefault + Cancel: destination receives nothing)
   ↓
Destination
```

There is no "paste, then clean up" path. `preventDefault()` (plus
`stopImmediatePropagation`) runs synchronously in the capture handler after
local detection and **before** the browser inserts anything. Enforcement does
not depend on hostnames: no `location`/`hostname` check exists on this path
(`src/content/pasteGuard.ts`), so an unknown AI clone is covered exactly like
a known chat site. Provider names in the UI orient the user; they are not
security inputs.

## Decisions and their meaning

| Decision | What the user sees | What the destination gets |
|---|---|---|
| ALLOW | nothing (no findings, or mode off) | the pasted text, normally |
| SANITIZE | dialog → Sanitize & Paste | `sanitizePastedText` output: detected spans replaced with `[REDACTED]` |
| BLOCK | dialog → Cancel/Esc/backdrop, or any dialog fault | nothing — the event stays cancelled |

"Paste Unchanged" is an explicit user override after seeing the findings, not
a bypass: the data was still intercepted first.

## Fail-closed rules (implemented, tested)

- Detection fault → the event is already cancelled; nothing is inserted.
- Dialog fault → catch path inserts **nothing** (a previous revision inserted
  the raw text here; `tests/paste-enforcement.test.ts` pins the closed
  behavior).
- Policy fault (unreadable settings) → defaults resolve to `this-tab` with
  full categories; an unreadable managed policy keeps the last resolved state
  rather than flapping.
- Invalid managed policy → locked UI, maximum protection (always-on, every
  category). A broken admin push never reads as "unmanaged".
- Unknown protection state → the status banner names the gap
  ("waiting for access"); "always on" is displayed only with proof
  (registration API present **and** the site-access grant still held).
- Unsupported mechanism (no registration API, no offscreen, no managed
  storage) → the limitation is stated in-product, never absorbed silently.

## Enterprise enforcement

Administrators deliver policy via `chrome.storage.managed`
(`schema/policy.json` declares the shape on Chromium): `protectionMode`,
`userCanDisable` (default false under management), `enforcedCategories`.
Resolution (`src/shared/enterprisePolicy.ts`):

- Unmanaged → user settings pass through.
- Locked → the admin mode is a **floor, never a ceiling**: admin `off` wins
  outright (explicit); otherwise the wider of admin/user modes enforces, and
  enforced categories merge additively — a preset switch, filter, or checkbox
  can never remove a mandated category (re-added at every decision point, and
  the content guard merges them independently of the UI).
- `userCanDisable: true` → user controls the mode; mandated categories still
  cannot be removed.

## No-AI, no-egress invariants (preserved)

- Detection is deterministic local analysis (`src/shared/wizardAnalyzer.ts`:
  no external LLM or AI-service dependency). No OpenAI/Anthropic/Gemini calls
  for detection, no remote LLM classification, no hosted OCR, no third-party
  content analysis. The only machine learning on the path is Tesseract
  WebAssembly shipped inside the package.
- No raw page text, document bytes, clipboard contents, or unmasked values
  cross the network — on any path, in any mode, managed or not. The opt-in
  account/billing and community surfaces carry metadata only (billing records,
  screened rule patterns), and both refuse while unconfigured.
- Telemetry/audit content, where enabled, is metadata only: category, policy
  ID, decision, timestamp, browser, extension version, event ID, hash. Never
  patient names, MRNs, diagnoses, prompts, or document bytes. Audit exports
  are ECDSA-signed (the signature proves an export is unaltered, not that the
  log is complete history).
- CSP `script-src 'self' 'wasm-unsafe-eval'`; no inline scripts, no remote
  code, no `eval` outside WASM. Document pages travel by store key, never in
  messages (`MAX_MESSAGE_BYTES` drops oversized messages whole).

## Adversarial review (this release)

Attempted bypasses and the outcome (see Phase 10 notes in the release
process; unit pins in `tests/paste-enforcement.test.ts`):

- Paste PHI/PII/API key into input, textarea, contenteditable → intercepted
  pre-insertion; cancel inserts nothing; sanitize inserts redacted text only.
- Unknown-hostname chat clone (`https://test-ai.example/`) → covered; no
  hostname logic exists to evade.
- Shadow-DOM editor, dynamically created editor, drag-and-drop text →
  intercepted.
- Dialog fault injection → nothing inserted (fail-closed).
- Mode off → paste flows normally (no false protection claim).
- Programmatic `input.value = x` by page script → **not interceptable**
  (no input event; platform limitation, documented in BROWSER_SUPPORT.md).
- Cross-origin iframe editor → **not reachable** (platform boundary,
  documented).
- Revoking site access with always-on selected → registration removed,
  banner reads "waiting for access".
- Managed lock + user toggle/clear attempts → policy enforced at the decision
  point, not just in the UI (checkboxes disabled *and* mandated categories
  re-added on save; content guard merges independently).

Anything on this list that regresses to an unlisted bypass is a release
blocker until fixed or explicitly documented as an unsupported browser
limitation.
