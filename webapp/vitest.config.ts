import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    // Playwright-Tests laufen separat via `pnpm e2e`.
    exclude: ["node_modules", "dist", ".next", "e2e/**"],
  },
});
