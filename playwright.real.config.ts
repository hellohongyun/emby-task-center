import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /(?:real-flows|virtual-libraries|mobile-library|mobile-card-keys|missing-episodes)\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 15_000 },
  use: {
    // The isolated fixture allocates a loopback port for each run.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
