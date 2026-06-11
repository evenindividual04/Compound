import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dirname = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node", passWithNoTests: true },
  resolve: { alias: { "@": path.resolve(dirname, "src") } },
});
