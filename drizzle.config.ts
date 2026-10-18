import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  out: "./packages/database/drizzle",
  schema: "./packages/database/src/schema.ts",
});
