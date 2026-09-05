import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where the vibehub back-end listens in development. */
const BACKEND = process.env.VIBEHUB_BACKEND ?? "http://localhost:3010";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5183,
    // Same-origin in dev so the session cookie behaves exactly like it does in production,
    // where the back-end serves the built front from the same host.
    proxy: {
      "/api": {
        target: BACKEND,
        changeOrigin: true,
        // Terminal, VNC and provisioning logs all ride WebSockets under /api.
        ws: true,
      },
      // The preview proxy tab (`/preview/<port>/...`) belongs to the back-end; HMR of the
      // PREVIEWED app rides WebSockets under it too.
      "/preview": {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  // The dev server pre-bundles dependencies with esbuild, and that pass does NOT inherit `build.target`
  // below — it falls back to esbuild's own default, which predates top-level await. noVNC ships one,
  // so `vite` died on startup ("Top-level await is not available in the configured target
  // environment") and the dev server never came up at all. Same target as the build, for the same
  // reason: the card browser's noVNC client.
  optimizeDeps: {
    esbuildOptions: { target: "es2022" },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // vibehub is a developer tool opened in a current browser, and the noVNC client it lazy-loads
    // for the card browser ships top-level await — which esbuild only emits from es2022 onwards.
    target: "es2022",
  },
});
