import { defineConfig } from "drizzle-kit";

// Only needs a database URL, so CI with just DATABASE_URL works.
const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "Docket configuration error:\n  - DATABASE_URL: required (or DATABASE_URL_DIRECT)",
  );
}

export default defineConfig({
  schema: "./src/server/db/schema",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
});
