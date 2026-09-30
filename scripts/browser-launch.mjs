// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// System-browser fallback for the headed verification harnesses.
//
// Default behavior is unchanged: Playwright's bundled Chromium, headed. On
// machines where the bundled build cannot be downloaded (CDN-blocked
// networks), set GW_BROWSER_CHANNEL=chrome (or msedge) to drive the installed
// browser instead. Every headed script in scripts/ spreads
// browserChannelArgs() into its launch options, so the override is one env
// var, not eleven edits per machine.
export function browserChannelArgs() {
  const channel = (process.env.GW_BROWSER_CHANNEL || "").trim();
  if (!channel) return {};
  if (channel === "chrome" || channel === "msedge" || channel === "chromium") {
    return { channel };
  }
  throw new Error(`Unsupported GW_BROWSER_CHANNEL=${JSON.stringify(channel)} (want chrome|msedge)`);
}
