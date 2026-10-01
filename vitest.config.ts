// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.e2e.spec.ts", "node_modules", "dist"],
    // Per-file environment, not a global `environment` setting.
    //
    // Most of this suite is deliberately Node: the service worker, validators
    // and message contract have no business touching a DOM, and `tests/paste-guard`
    // builds its own element mocks that jsdom's read-only `parentNode` rejects.
    // The files that do need a DOM opt in per file with a
    // `// @vitest-environment` directive, which is why the environment is
    // configured here per test rather than switched on for everything.
    //
    // `happy-dom` boots far faster than jsdom and is what the other DOM suites
    // here already use; jsdom is used only where a test needs jsdom's specific
    // behaviour (see tests/page-inventory.test.ts for why).
    pool: "forks",
    // jsdom's boot is slow enough that, under a fully parallel run on a loaded
    // machine, one worker could miss Vitest's internal 60s start deadline and
    // take the whole suite down with "Timeout waiting for worker to respond".
    // This only governs how many files boot at once.
    maxWorkers: 4,
  },
});