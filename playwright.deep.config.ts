import { defineConfig } from "@playwright/test";
import isolated from "./playwright.real.config";

export default defineConfig({
  ...isolated,
  testMatch:
    /(?:real-flows|deep-browser|library-order|member-registration(?:-boundaries)?|member-inactivity-cleanup|member-reduction(?:-boundaries)?|system-logs|share-115)\.spec\.ts/,
});
