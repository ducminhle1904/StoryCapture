import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 4176, strictPort: true },
  preview: { port: 4176, strictPort: true },
  build: { outDir: "dist-catalog", emptyOutDir: true },
});
