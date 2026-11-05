import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests against the real local backend (http://localhost:4000 by default, or
 * NEXT_PUBLIC_BACKEND_URL). They sign in with a local admin key, so they run locally only; CI
 * checks lint, types and the build. Tests change candidate rows and put them back, so they run
 * one at a time.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    // E2E_BASE_URL points the run at another panel build (one beside the running :3001).
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "laptop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: "npm run dev",
    url: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
