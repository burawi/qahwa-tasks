import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  publicDir: "../../public",
  build: {
    outDir: "../../dist/public",
    // Keep prior content-hashed chunks so an already-open client can finish
    // loading them while a new release is deployed.
    emptyOutDir: false,
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:3022" },
  },
});
