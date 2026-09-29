# GovernWorld Redaction — Permission Justification

Chrome Web Store reviewers ask why an extension needs each permission. This
document maps every permission in `manifest.json` to the exact feature that
uses it, and lists permissions the extension deliberately does **not** request.

## Requested permissions

| Permission   | Why it is needed | Used by |
|--------------|------------------|---------|
| `activeTab`  | Grants one-time access to the current tab **only** after the user presses "Scan this page". The extension never gains background access to all tabs and never scans without user action. | `src/service-worker/index.ts` (injection orchestration) |
| `scripting`  | Injects the content script that extracts visible text and renders overlay masks into the active tab, only after the `activeTab` grant. | `src/service-worker/index.ts` |
| `storage`    | Persists user preferences (detection categories, mode) in `chrome.storage.local` and ephemeral scan session state in `chrome.storage.session`. Never stores raw content. | `src/shared/settings.ts`, `src/service-worker/index.ts` |
| `downloads`  | Saves the flattened redacted copy the user explicitly creates, with the browser's save dialog (`saveAs: true`). The original file is never touched. | `src/service-worker/documents.ts` |
| `offscreen`  | Runs document rendering (pdf.js) and OCR (tesseract.js) in a dedicated offscreen document, because MV3 service workers have no DOM or `Worker` API. | `src/offscreen/offscreen.ts` |
| `sidePanel`  | Shows the GovernWorld side panel, a persistent surface for scanning, findings review, document redaction, notifications, and account/extension-license management. It opens via the popup's "Open side panel" button and the `Alt+Shift+P` command. | `manifest.json` (`side_panel`, `commands`), `src/service-worker/index.ts` (`chrome.sidePanel.open`), `src/popup/popup.ts` |
| `contextMenus` | Adds three entries to the browser context menu — "Scan page for sensitive data", "Redact selection to clipboard", and "Mask selected text / element" — so the same on-demand actions can be started from a right-click. The entries are created only while the user has the setting enabled and are removed when it is disabled. It grants no access to page content by itself: each entry still runs the existing user-initiated scan path and still depends on an explicit click. | `src/service-worker/index.ts` (`syncContextMenus`, `chrome.contextMenus.onClicked`), `src/shared/settings.ts` (`contextMenusEnabled`) |

## Optional permissions (requested at runtime, never at install)

| Permission      | Why it is requested | When |
|-----------------|---------------------|------|
| `notifications` | Raises a system notification when a scan finds sensitive data — only if the user enables the "Notify me" toggle. Denied requests simply stay off; no functionality depends on it. | Side panel → Notifications toggle |

## Declared `host_permissions`

**None.** The extension declares **zero host permissions** and **zero automatic site-access permissions**. It operates entirely on-device with zero automatic access to any website.

## Permissions the extension deliberately does NOT request

| Permission     | Why it is avoided |
|----------------|-------------------|
| `<all_urls>` / host permissions | No background or automatic access to web traffic or sites. |
| `tabs`         | Unnecessary; `activeTab` covers the one user-chosen tab without requesting browsing history. |
| `webRequest`   | The extension must not observe or modify network traffic. |
| `clipboardRead`| Clipboard writes use the standard `navigator.clipboard.writeText` with no read permission. |
| `history` / `bookmarks` | No feature touches browsing history or bookmarks. |
| `cookies`      | No cookies are read or written. |
| `notifications`| Requested only as an optional permission (see above) — never required at install. |

## Data handling

- No raw scanned text or page snapshots are persisted to storage, logs, telemetry, analytics, or error reporting.
- Scan session state lives in `chrome.storage.session` (cleared on browser restart) and holds findings metadata with masked previews only.
- File bytes for the document you open are staged in the extension's private IndexedDB only while you review or redact the file. Clear-data, document-clear, completed redaction, and the next service-worker startup remove staged files.
- No scan content or raw sensitive data is transmitted to the cloud. All detection, OCR, and redaction execute 100% locally on your machine.