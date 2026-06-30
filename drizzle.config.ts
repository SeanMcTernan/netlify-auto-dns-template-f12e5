import { defineConfig } from "drizzle-kit";

// Migrations are generated here and APPLIED BY THE NETLIFY DEPLOY for hosted DBs.
// Only the local dev DB is migrated by hand (`npm run db:migrate`).
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "netlify/database/migrations", // critical: Netlify only auto-applies from here
});
