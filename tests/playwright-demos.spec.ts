// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Playwright demos for GovernWorld Redaction — run without extension load for quick buyer proof.
// For full extension E2E (with persistent context + --load-extension), see tests/extension.e2e.spec.ts
// Run: npx playwright test tests/playwright-demos.spec.ts --reporter=list
// Screenshots: test-results/demo-*/
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_HTML = readFileSync(join(import.meta.dirname, "fixtures/page.html"), "utf8");

test.describe("GovernWorld Redaction — Playwright Demos (no extension required)", () => {
  // Demo 1: 5-minute local scan proof — synthetic PHI is present, hidden fields are ignored
  test("demo: 5-minute local scan — synthetic PHI present", async ({ page }) => {
    await page.setContent(FIXTURE_HTML);
    // Synthetic PII/PHI is in the table (MRN, SSN, email, phone) — these are what the extension would mask
    await expect(page.getByText("Jane Doe")).toBeVisible();
    await expect(page.getByText("123-45-6789")).toBeVisible(); // SSN — would be redacted
    await expect(page.getByText("jane.doe@example.com")).toBeVisible();
    await expect(page.getByText("(415) 555-0199")).toBeVisible();
    // Hidden / form fields are marked ignored — extension must not surface password-value
    await expect(page.locator("[data-sensitive-scan-ignore]")).toContainText("cc-4111111111111111");
    await page.screenshot({ path: "test-results/demo-5min-before.png", fullPage: true });
    // Simulate what the extension's overlay would do: highlight the PHI cells
    await page.evaluate(() => {
      for (const td of Array.from(document.querySelectorAll("td"))) {
        if (/123-45-6789|jane\.doe@example\.com|\(415\) 555-0199/.test(td.textContent || "")) {
          (td as HTMLElement).style.outline = "3px solid #e11d48";
          (td as HTMLElement).style.background = "#ffe4e6";
        }
      }
    });
    await page.screenshot({ path: "test-results/demo-5min-after.png", fullPage: true });
  });

  // Demo 2: Healthcare — clinical note paste would be redacted before egress
  test("demo: healthcare — clinical note redaction", async ({ page }) => {
    const clinicalNote = [
      "Patient MRN 44219, DOB 1984-03-14, SSN 123-45-6789",
      "Admitted 2026-08-10 for acute bronchitis (J20.9), Type 2 diabetes (E11.9).",
      "Contact: jane.doe@example.com, (415) 555-0199, 742 Evergreen Terrace, Springfield, IL 62704",
      "Emergency: Mark Doe (415) 555-0142",
    ].join("\n");
    await page.setContent(`
      <html><body style="font-family: sans-serif; max-width: 760px; margin: 40px auto;">
        <h1>AI Assistant — Paste Clinical Note</h1>
        <textarea id="prompt" rows="8" style="width:100%; font-family: monospace;"></textarea>
        <pre id="redacted" style="background:#f1f5f9; padding:16px; margin-top:16px; white-space:pre-wrap;"></pre>
        <script>
          const ta = document.getElementById('prompt');
          const pre = document.getElementById('redacted');
          ta.addEventListener('input', () => {
            let t = ta.value;
            t = t.replace(/\\d{3}-\\d{2}-\\d{4}/g, '[REDACTED_SSN]');
            t = t.replace(/\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b/g, '[REDACTED_EMAIL]');
            t = t.replace(/\\(\\d{3}\\) \\d{3}-\\d{4}/g, '[REDACTED_PHONE]');
            t = t.replace(/MRN \\d+/g, 'MRN [REDACTED_MRN]');
            pre.textContent = t;
          });
        </script>
      </body></html>
    `);
    await page.fill("#prompt", clinicalNote);
    await expect(page.locator("#redacted")).toContainText("[REDACTED_SSN]");
    await expect(page.locator("#redacted")).toContainText("[REDACTED_EMAIL]");
    await expect(page.locator("#redacted")).toContainText("[REDACTED_PHONE]");
    await page.screenshot({ path: "test-results/demo-healthcare.png", fullPage: true });
  });

  // Demo 3: Legal — matter + privileged doc marker, same local-first path
  test("demo: legal — matter redaction", async ({ page }) => {
    await page.setContent(`
      <html><body style="font-family: sans-serif; max-width: 760px; margin: 40px auto;">
        <h1>Matter Draft — Privileged</h1>
        <div style="background:#fff7e6; border:1px solid #e6c98a; padding:12px; margin:16px 0;">
          Synthetic matter — no real client data.
        </div>
        <textarea id="legal" rows="6" style="width:100%;">Client: Acme Corp, Matter: 2026-ML-0192, Outside counsel: jane.doe@example.com, SSN 123-45-6789 on retainer.</textarea>
        <div id="out" style="background:#f1f5f9; padding:12px; margin-top:12px;"></div>
        <script>
          const ta=document.getElementById('legal'), out=document.getElementById('out');
          function redact(s){ return s.replace(/\\d{3}-\\d{2}-\\d{4}/g,'[REDACTED_SSN]').replace(/\\b[\\w.%+-]+@[\\w.-]+\\.[A-Za-z]{2,}\\b/g,'[REDACTED_EMAIL]'); }
          ta.addEventListener('input', ()=> out.textContent=redact(ta.value));
          out.textContent=redact(ta.value);
        </script>
      </body></html>
    `);
    await expect(page.locator("#out")).toContainText("[REDACTED_SSN]");
    await page.screenshot({ path: "test-results/demo-legal.png", fullPage: true });
  });
});
