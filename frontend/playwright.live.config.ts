import { defineConfig } from "@playwright/test";

/**
 * Live end-to-end tests against a running app (default http://localhost:3000, the production build;
 * override with E2E_BASE_URL) wired to the live Testnet backend and relayer. Each test signs
 * up a brand-new passkey account, so runs are independent of each other and of earlier runs. Start
 * the app first, then:
 *   npx playwright test -c playwright.live.config.ts
 */
process.env.TREDIO_LIVE = "1";

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.live\.spec\.ts$/,
  timeout: 300_000,
  expect: { timeout: 45_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results/live",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
