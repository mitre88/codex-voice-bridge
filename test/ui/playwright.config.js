import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  timeout: 30000,
  workers: 1,
  retries: 0,
  outputDir: "../../.artifacts/ui-results",
  reporter: [["list"], ["json", { outputFile: ".artifacts/ui-results/results.json" }]],
});
