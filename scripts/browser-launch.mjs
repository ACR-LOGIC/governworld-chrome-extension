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
