import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@throwin\/shared$/,
        replacement: fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 20000 },
});
