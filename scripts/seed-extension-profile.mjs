// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Seeds a Chrome profile with the current dist/ extension via CDP.
// Chrome >=137 ignores --load-extension, so we drive chrome://extensions
// directly through the DevTools protocol.
//
// Usage:
//   node scripts/seed-extension-profile.mjs [profileDir]
//
// Default profile dir: C:\GW\profile

import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extRoot = join(fileURLToPath(import.meta.url), "..", "..");
const distPath = join(extRoot, "dist");
const profileDir = process.argv[2] || "C:\\GW\\profile";

if (!existsSync(join(distPath, "manifest.json"))) {
  console.error("dist/manifest.json not found — run npm run build first");
  process.exit(1);
}

console.log(`Seeding profile: ${profileDir}`);
console.log(`Extension path: ${distPath}`);

const browser = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  channel: "chrome",
  args: ["--no-first-run", "--no-default-browser-check"],
});

try {
  const page = await browser.newPage();
  await page.goto("chrome://extensions", { waitUntil: "networkidle", timeout: 15000 });

  // Enable Developer Mode
  await page.evaluate(() => {
    const manager = document.querySelector("extensions-manager");
    const toolbar = manager?.shadowRoot?.querySelector("#toolbar");
    const devMode = toolbar?.shadowRoot?.querySelector("#devMode") as HTMLInputElement;
    if (devMode && !devMode.checked) devMode.click();
  });
  await page.waitForTimeout(500);

  // Click "Load unpacked" and handle the file chooser
  const loadUnpackedBtn = page.locator("extensions-manager").locator("#toolbar").locator("#loadUnpacked");
  if (await loadUnpackedBtn.isVisible().catch(() => false)) {
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10000 }),
      loadUnpackedBtn.click(),
    ]);
    await fileChooser.setFiles(distPath);
    console.log("Loaded unpacked extension via file chooser");
    await page.waitForTimeout(2000);
  } else {
    console.log("Load unpacked button not found");
  }

  // Verify
  const count = await page.locator("extensions-item-list").locator("extensions-item").count();
  console.log(`Extensions in profile: ${count}`);
  for (let i = 0; i < count; i++) {
    const name = await page.locator("extensions-item-list").locator("extensions-item").nth(i).locator("#name").textContent().catch(() => "unknown");
    console.log(`  - ${name}`);
  }

  if (count === 0) {
    console.log("\nExtension not loaded. Trying CDP approach...");
    const cdp = await page.context().newCDPSession(page);
    // Use CDP to install the extension
    const result = await cdp.send("Browser.installExtension", {
      path: distPath,
    }).catch((e) => ({ error: String(e) }));
    console.log("CDP install result:", JSON.stringify(result));
  }

  await page.waitForTimeout(1000);
} catch (err) {
  console.error("Seeding failed:", err);
} finally {
  await browser.close();
}
