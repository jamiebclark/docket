# Decisions log

Judgement calls made while building, newest last. Each entry: what, why, and
how to reverse it. The owner reviews these; anything here can be overturned.

## 2026-10-02/03 — step 0 (bootstrap, made by hand before the roadmap)

1. **pnpm + Node 24 LTS**, `engines: >=24.10 <25` (semantic-release needs
   ≥24.10). Owner answer.
2. **License: MIT.** Repo is public and meant to be self-deployable. Change the
   `LICENSE` file if another license is preferred.
3. **Instagram via Facebook Login for Business**, not Instagram Login — one
   OAuth flow yields Page tokens and linked IG account ids. See
   `docs/research/meta.md`.
4. **Better Auth organization plugin = projects**, plus Docket-owned hashed
   `invitation_tokens`, per-request membership checks, and a sign-up hook
   gate. See `docs/research/better-auth.md` for the gaps this covers.
5. **Time zones via `@js-temporal/polyfill`** (Temporal is not unflagged in
   Node 24).
6. **No Postgres RLS**; scope enforced by DAL + ESLint import ban + query-log
   test. Owner answer.
7. **OpenAPI via `zod-openapi`** (Zod 4 native JSON Schema). Not yet installed.
8. **CI** = one workflow: commitlint (PRs), lint, typecheck, `db:check` (once
   Drizzle exists), Vitest against a `postgres:17` service, `next build`,
   Docker build, then semantic-release on `main` after those pass.
9. **semantic-release** bumps `package.json` and `CHANGELOG.md` and commits
   back as `chore(release): x.y.z [skip ci]`; no npm publish; GitHub release.
10. **Merge strategy**: the roadmap runner squash-merges whenever the repo
    allows squash. Asked the owner to disable squash merging so `main` keeps the
    small conventional commits semantic-release reads. If squash is still
    enabled at run time, entries land as a single `feat(<slug>)` commit each.
11. **speckit auto-commit stays off** (it runs `git add .`); phases commit per
    task with explicit paths per the constitution. `commit_style` set to
    `conventional` in case a hook fires.
12. **Docker image**: single `node:24-slim` multi-stage image for both `web`
    and `worker`; optional BuildKit secret `extra_ca` for building behind a
    TLS-intercepting proxy (the owner's laptop). Nothing machine-specific is
    baked in.
13. **Research lives in `docs/research/`** because pipeline phases cannot use
    the web. The `platform-researcher` agent refreshes it.
14. **UI guidance is a project skill (`docket-ui`)**, not a sub-agent, because
    pipeline phases cannot spawn agents but do load skills.
15. **Postgres 17** image for Compose and CI (current stable major supported
    by Neon). Bump deliberately.
16. **System font stack instead of `next/font/google`** (Geist). Removes the
    build-time download from Google Fonts, which broke Docker builds behind a
    proxy and leaks requests to Google for self-hosters. Reverse by using
    `next/font/local` with a vendored font file.
