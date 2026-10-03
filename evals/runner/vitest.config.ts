import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@throwin\/workers\/eval$/,
        replacement: fileURLToPath(
          new URL("../../services/workers/src/eval-exports.ts", import.meta.url),
        ),
      },
      {
        find: /^@throwin\/harness$/,
        replacement: fileURLToPath(new URL("../../services/harness/src/index.ts", import.meta.url)),
      },
      {
        find: /^@throwin\/shared$/,
        replacement: fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 20000 },
});
