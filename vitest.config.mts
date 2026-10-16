import { defineConfig } from "vitest/config";

import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // `geode` only exists at plugin runtime (the loader's require shim); tests vi.mock it, but Vite must still resolve it.
    alias: { geode: fileURLToPath(new URL("./tests/unit/stubs/geode.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
