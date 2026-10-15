import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@syntaxdm/contracts": resolve(here, "../../packages/contracts/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
