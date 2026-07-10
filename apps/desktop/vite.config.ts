import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    port: 1420,
    strictPort: true,
    host: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(here, "./src"),
      "@shared-types": path.resolve(here, "../../packages/shared-types/src"),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
