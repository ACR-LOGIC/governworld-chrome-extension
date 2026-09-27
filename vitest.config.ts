// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.e2e.spec.ts", "node_modules", "dist"],
  },
});