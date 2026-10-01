// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// System-browser fallback for the headed verification harnesses.
//
// Default behavior is unchanged: Playwright's bundled Chromium, headed. Two
// overrides for machines where the bundled build cannot be downloaded
// (CDN-blocked networks):
//   GW_BROWSER_CHANNEL=chrome|msedge|chromium  drive the installed browser.
//   GW_BROWSER_EXECUTABLE=/path/to/chrome(.exe)  drive an exact binary (e.g. a
//     manually fetched Chrome-for-Testing). Takes precedence over the channel.
// Every headed script in scripts/ spreads browserChannelArgs() into its
// launch options, so the override is env vars, not edits per machine.
//
// Pre-seeded profiles: Chrome ≥137 ignores CLI-loaded unpacked extensions,
// so automation cannot install the extension itself. The workaround is a
// one-time GUI load (Developer Mode → Load unpacked) into a stable profile
// directory, which every script then reuses via browserProfileDir():
//   1. Launch the CFT/system binary once with
//      --user-data-dir=C:\GW\profile (any stable path).
//   2. Open chrome://extensions, enable Developer Mode, Load unpacked → dist/.
//   3. Close the browser, then run headed scripts with
//      GW_BROWSER_PROFILE_DIR=C:\GW\profile
// The extension stays installed in that profile across runs. Scripts must
// never delete the override directory (they only clean their own temp work
// dirs, which live elsewhere when the override is set).
import { existsSync, mkdirSync } from "node:fs";

export function browserProfileDir(fallback) {
  const override = (process.env.GW_BROWSER_PROFILE_DIR || "").trim();
  if (!override) return fallback;
  if (!existsSync(override)) mkdirSync(override, { recursive: true });
  return override;
}
export function browserChannelArgs() {
  const executable = (process.env.GW_BROWSER_EXECUTABLE || "").trim();
  if (executable) return { executablePath: executable };
  const channel = (process.env.GW_BROWSER_CHANNEL || "").trim();
  if (!channel) return {};
  if (channel === "chrome" || channel === "msedge" || channel === "chromium") {
    return { channel };
  }
  throw new Error(`Unsupported GW_BROWSER_CHANNEL=${JSON.stringify(channel)} (want chrome|msedge)`);
}

/**
 * Wait until the popup has actually wired its event listeners.
 *
 * `initPopup` awaits settings and storage before it attaches a single listener
 * (see src/popup/entry.ts for why that ordering exists). Measured on this
 * machine it completes ~3.4s after the popup document loads, while every harness
 * used to wait a fixed 2-2.5s and then drive the UI.
 *
 * That raced the listeners, not the pipeline: the harness dispatched `change` on
 * a file input with nothing bound to it, so no document was ever staged and the
 * run reported "the studio previewed the image" as a product failure. A fixed
 * sleep is the wrong tool — the delay depends on storage latency and machine
 * load, so a faster or slower machine silently flips the result.
 *
 * The marker must be one init sets AFTER attaching listeners. Several plausible
 * proxies are already populated by the static markup (the OCR language select
 * has its `<option>` elements in index.html, so it reads as "ready" within 4ms)
 * and therefore prove nothing about the listeners.
 *
 * `document.documentElement.dataset.gwReady` is set at the end of `initPopup`,
 * once every listener is bound. Falls back to a bounded wait so a genuinely
 * broken popup reports its own failure rather than hanging here forever.
 */
export async function waitForPopupReady(page, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => document.documentElement.dataset.gwReady === "1")
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(100);
  }
  console.warn("[governworld] popup did not report ready in time; continuing anyway.");
  return false;
}

/**
 * Stage a file into the popup exactly as a user would, once it is interactive.
 *
 * `FileList` cannot be constructed directly, so a DataTransfer is used to assign
 * `input.files` and a `change` event is dispatched from inside the page. This is
 * what every document harness needs, and it is the step that silently did nothing
 * whenever the popup had not finished initialising.
 */
export async function stageFileInPopup(page, bytes, name, mimeType) {
  const ready = await waitForPopupReady(page);
  if (!ready) throw new Error("The extension popup never became interactive.");
  await page.evaluate(
    ({ b64, fileName, type }) => {
      const input = document.getElementById("doc-file-input");
      if (!input) throw new Error("The document file input is missing from the popup.");
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], fileName, { type }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { b64: bytes.toString("base64"), fileName: name, type: mimeType }
  );
  return ready;
}
