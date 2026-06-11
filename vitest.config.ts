import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dirname = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  // DB-backed suites share one test database — files must not run concurrently.
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    fileParallelism: false,
  },
  resolve: { alias: { "@": path.resolve(dirname, "src") } },
});
