import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `scripts/**` is where install-private tooling lives (it is gitignored); its tests run with the
    // suite so a change to a shape it depends on breaks here rather than during a migration.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "html"] },
  },
});
