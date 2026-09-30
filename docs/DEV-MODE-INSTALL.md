# Developer-mode install guide (unpacked / temporary)

Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

Unload the store build first if you have it installed: a dev-mode copy and the
store copy share storage and will fight over settings.

## Chromium (Chrome 116+, Edge 116+, Brave, Opera, Vivaldi, Arc)

Rule: GUI load only. Google removed the `--load-extension` command-line flag
in Chrome 137, so CLI-driven loading silently does nothing on current
browsers — the button below is the only dev-mode path.

1. Unzip `GovernWorld-Chromium-v<V>-<sha>.zip` (or point at `dist/`).
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn ON **Developer mode** (top-right).
4. Click **Load unpacked**, select the unzipped folder (must contain
   `manifest.json` at its root).
5. Pin the shield icon from the toolbar puzzle menu.

Undo: return to the extensions page → Remove. Dev-mode copies update when you
rebuild; click the reload icon on the extension card after `npm run build`.

## Firefox 109+ (temporary add-on)

1. Unzip `GovernWorld-Firefox-v<V>-<sha>.zip` (or point at `dist-firefox/`).
   Do NOT load the Chromium zip in Firefox.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**, open the folder, select `manifest.json`.
4. The shield appears in the toolbar; the panel lives in the sidebar action.

Rules: temporary add-ons vanish on browser restart (reload after restart);
Document Studio reports an explicit error where the offscreen API is absent —
page scanning, masks, and paste protection are unaffected. Persistent install
needs a signed `.xpi` (rename the zip) via `about:addons` →
Install Add-on From File (unbranded/Developer Edition Firefox).

## Safari (macOS)

The Safari handoff zip (`GovernWorld-Safari-handoff-*.zip`) is a packaging
input, not an installable extension. To install it you must first package it
as an app — pick one:

- **With a Mac + Xcode:** `xcrun safari-web-extension-packager <unzipped
  folder> --project-location <out> --app-name "GovernWorld"`, open the
  generated project, Run, then enable in Safari → Settings → Extensions.
- **Without a Mac:** App Store Connect → web-based Safari web extension
  packager (Apple Developer Program membership required) → TestFlight.
- **Fastest local check on a Mac (no Xcode project):** Safari → Settings →
  Advanced → **Show features for web developers** → Develop menu →
  **Allow Unsigned Extensions** → add the unzipped folder as a temporary
  extension (removed after 24h or on quit).

Rule: a Safari web extension governs supported activity inside Safari only —
not iMessage, native apps, or iOS. Never describe it otherwise.

## After installing (any browser)

1. Open the popup → Protection tab: status reads "this tab only" by default.
2. Open any page, open the extension there, paste `219-09-9999` into a form
   field: the Paste Shield dialog must appear BEFORE the text is inserted.
3. Sanitize → only `[REDACTED]` lands. Cancel/Esc → nothing lands.
4. Always-on: Protection settings → check the always-on box → approve the
   browser's site-access prompt. The banner must read active only after the
   grant; revoke the grant and it must fall back to "waiting for access".
