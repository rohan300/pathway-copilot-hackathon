import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json, so route handlers under
    // app/ can be imported by their tests exactly as they import each other.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["{app,lib}/**/*.test.ts"],
  },
});
