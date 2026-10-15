import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Renderer bundle: statically loaded by the Electron main process via file:// in production.
// All runtime communication goes through the typed preload bridge (window.syntaxdm), never
// through raw Node APIs — hence a strict CSP in index.html and base './' for relative assets.
export default defineConfig({
  root: resolve(here, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(here, "dist/renderer"),
    emptyOutDir: true,
    sourcemap: true,
    target: "chrome142",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
