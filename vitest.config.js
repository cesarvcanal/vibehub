import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.mjs", "eslint.config.test.mjs"],
    exclude: ["**/node_modules/**"],
  },
});
