// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { initPopup } from "../popup/popup.js";

async function initPanel(): Promise<void> {
  await initPopup();
}

void initPanel();
