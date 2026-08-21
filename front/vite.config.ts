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
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
