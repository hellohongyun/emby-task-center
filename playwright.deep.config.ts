import { defineConfig } from "@playwright/test";
import isolated from "./playwright.real.config";

export default defineConfig({
  ...isolated,
  testMatch: /(?:real-flows|deep-browser)\.spec\.ts/,
});
