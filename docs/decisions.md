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
9. **semantic-release** creates a git tag and a GitHub release (notes from
   conventional commits) on `main`; no npm publish. It does **not** commit back
   (`package.json` version / `CHANGELOG.md`) because the `main` ruleset requires
   pull requests. The tag/release is the source of truth for the version.
10. **Merge strategy**: the owner's `main` ruleset requires PRs and allows only
    the `merge` method, which keeps the small conventional commits. The repo-level
    "Allow squash merging" flag is still on, and the roadmap runner picks squash
    from that flag (then the ruleset refuses it). Until the flag is unticked,
    roadmap runs use a PATH shim for `gh` (scratchpad, not in the repo) that
    reports only `merge` as allowed. **Owner action**: untick "Allow squash
    merging" (and "Allow rebase merging") in Settings → General.
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
17. **Roadmap titles kept short** so the runner's fallback commit
    `feat(<slug>): <title>` fits commitlint's 100-char header limit.
18. **Roadmap split to 10 entries** (owner-approved): `meta` became
    `meta-facebook-instagram` + `meta-threads` (separate app, OAuth hosts and
    token lifecycle), and `jobs-and-api` became `generation-jobs` +
    `public-api` (job engine lands and is tested before the API exposes it).
    The run started with 8 entries counts only 8, so the last two
    (`public-api`, `hardening`) need one more `spec-roadmap run`.
