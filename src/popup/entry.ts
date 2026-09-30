// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { initPopup } from "./popup.js";

/**
 * Initialisation failures must not be silent.
 *
 * `initPopup` awaits settings and storage before it attaches a single event
 * listener, so a rejected promise leaves the popup with working markup and no
 * behaviour: every button looks enabled and does nothing. `void initPopup()`
 * discarded the rejection, which is how that became a silent, unreproducible
 * "the extension does nothing" report. The message is surfaced to the user
 * because an unlabelled dead UI is indistinguishable from a broken extension.
 */
void initPopup().catch((error: unknown) => {
  console.error("[governworld] popup failed to initialise:", error);
  const status = document.getElementById("doc-status-text");
  if (status) {
    status.textContent = "GovernWorld could not start. Reload the extension and try again.";
    status.classList.add("status--error");
  }
  const wrapper = document.getElementById("doc-status");
  if (wrapper) wrapper.hidden = false;
});
