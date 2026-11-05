import { defineConfig, devices } from "@playwright/test";

/** Browser end-to-end tests against the local stack in e2e/stack.ts. */
export default defineConfig({
  testDir: "e2e",
  // Live Testnet specs have their own config (playwright.live).
  testIgnore: [/\.live\.spec\.ts$/, /\.testnet\.spec\.ts$/],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "bun e2e/stack.ts",
    url: "http://localhost:3100",
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
