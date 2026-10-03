# Tooling — verified versions and facts

Checked 2026-10-02 against npm registry and official repos.

| Package | Version | Notes |
|---|---|---|
| next | 16.3.8 | `output: "standalone"` still documented; copy `public/` and `.next/static` yourself. Bundled docs: `node_modules/next/dist/docs/` |
| drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 | `.for("update", { skipLocked: true })` exists (also `noWait`, `of`) — confirm against installed types |
| zod | 4.6.5 | native `z.toJSONSchema()` incl. `openapi-3.0` target |
| zod-openapi | 6.0.2 | chosen OpenAPI generator (builds on Zod 4 JSON Schema) |
| vitest | 5.0.3 | |
| tailwindcss | 4.3.3 | CSS-first config (`@import "tailwindcss"`, `@theme`), `@tailwindcss/postcss` |
| semantic-release | 25.0.9 | needs Node ^22.14 or >=24.10 |
| husky / commitlint | 9.1.7 / 21.2.3 | |
| sharp | 0.35.5 | prebuilt for linux x64/arm64 glibc ≥2.28 (slim) and musl; enable in `pnpm-workspace.yaml` `allowBuilds` |
| @atproto/api | 0.23.0 | see bluesky.md |
| better-auth | 1.7.7 | see better-auth.md |

## Postgres / Neon
- `drizzle-orm/node-postgres` with plain `pg` works on Neon with only the
  connection string (`sslmode=require`).
  https://neon.com/docs/get-started-with-neon/connect-neon
- Neon's `-pooler` host is PgBouncer in **transaction mode**: transactions with
  `FOR UPDATE SKIP LOCKED` are fine; session features (advisory locks, LISTEN,
  possibly named prepared statements) are not. Run migrations on the direct URL
  (`DATABASE_URL_DIRECT`, falling back to `DATABASE_URL`).

## Time zones
- Temporal is **not** unflagged in Node 24 (Node 26 enables it). Use
  `@js-temporal/polyfill`; `Temporal.ZonedDateTime.from({...}, { disambiguation })`
  handles DST gaps (`'compatible'` moves forward) and overlaps (`'earlier'`/`'later'`).
  Code ports to native Temporal unchanged.

## Local environment caveat (owner's machine)
- The dev machine sits behind a TLS-intercepting proxy. Docker builds pass the
  host CA bundle as an optional BuildKit secret:
  `security find-certificate -a -p /Library/Keychains/System.keychain /System/Library/Keychains/SystemRootCertificates.keychain > /tmp/extra-ca.pem`
  then `docker build --secret id=extra_ca,src=/tmp/extra-ca.pem .`
  CI does not need it.
