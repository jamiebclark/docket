# Quickstart: validating Requirements up front (017)

Everything here runs offline with mocked providers (constitution II). There are no live platform calls, so results are "verified with mocks only".

## Prerequisites

- Node 24, `pnpm install` already done (no new dependency).
- Postgres for the integration suites, as for every entry (`docker compose up -d postgres` or the CI service). Test databases are run-scoped.
- No migration, environment variable or `docker-compose.yml` change (research P15).

## 1. Providers: values, caption rules, summary (US1, US3)

```sh
pnpm vitest run src/providers/text.test.ts src/providers/validation.test.ts src/providers/requirements.test.ts src/providers/registry.test.ts src/providers/media.test.ts
```

Expect:

- **Counting.** `countHashtags` and `countMentions` give the counts in research F12, and the spec's edge cases (URL `#`, lone `#`, `#123`, `C#`, email) count 0.
- **Validation.** For Instagram, 31 hashtags or 21 mentions gives a `too_many_hashtags`/`too_many_mentions` error with `count` and `limit`. Exactly 30 and 20 gives neither.
- **Summary.** `requirementsOf` for every registered provider equals that provider's capabilities field by field (SC-001), with `null` where nothing is declared (D11). Changing a declared value in a test double changes the summary (FR-003).
- **Planner.** `planImage` with `label: "This image"` words its messages that way, and the decisions are unchanged.

## 2. Limits inventory and generated enforcement (US3, SC-005, SC-006)

```sh
pnpm vitest run tests/integration/docs/limits-inventory.test.ts tests/integration/limits/enforcement.test.ts tests/integration/docs/provider-guide.test.ts tests/integration/instagram/limits.test.ts
```

Expect:

- **Inventory.** It passes, including the new `hashtags`, `mentions` and Instagram `min width` rows. The only UNVERIFIED rows are Facebook `text length` and `images`.
- **Enforcement.** It runs `instagram: hashtags` and `instagram: mentions` in the core and text suites, refused at `addToQueue` and again at publish time with zero platform requests. It also runs `instagram: min width` in the planner suite, `instagram: publish limit 50 / 86400 s`, and `facebook: bytes per file` at 10000000.
- **Instagram limits.** Docket's own counter stops Instagram at 50 publishes per 24 h, while the fake `quota_total` stays 100.

## 3. Compose check carries the summary (US1, FR-002, FR-004)

```sh
pnpm vitest run tests/integration/compose-check-route.test.ts tests/integration/compose/check.test.ts src/app/p/[projectSlug]/compose/Composer.test.ts src/components/compose
```

Expect:

- **Empty composer.** A check with `baseText: ""`, no media and one Instagram target returns `requirements` matching [contracts/compose-check.md](./contracts/compose-check.md). A Bluesky target returns 300 graphemes, 4 images, JPEG and PNG, and `aspectRatio` and `maxAltTextLength` both `null`.
- **FR-004.** `requirements.text.maxLength === limit` and `requirements.text.countingRule === countingRule` for every target, including over-limit text.
- **Unregistered provider.** An account on an unregistered provider gets `requirements: null`.
- **Caption rules.** A caption with 31 hashtags is blocked in the check (`canSchedule: false`). One with 30 hashtags and 20 mentions is not.
- **Markup.** The composer's rendered markup shows one summary per selected account with every field from US1 AS1/AS2. Deselecting an account removes its summary (AS3), and the counter and issues still render.

## 4. Fit badges (US2, SC-003)

```sh
pnpm vitest run tests/integration/media/fit.test.ts tests/integration/media/library.test.ts src/components/media
```

Expect:

- **SC-003.** For each registered provider and the fixed image set, `fitOf` equals the planner's decision. The set is: 1080×1350 JPEG; WebP; 3000×1000 PNG; 200-px-wide JPEG; oversize JPEG; 1:20 extreme aspect; a row without dimensions.
- **US2 scenarios:**
  - AS1: Instagram and Facebook both fit the 1080×1350 JPEG.
  - AS2: WebP gives Instagram and Facebook "will be converted" (to JPEG) and X "fits".
  - AS3: the 3:1 panorama is refused for Instagram (too wide) and fits or is converted for Threads.
  - AS4: the 200 px image is refused for Instagram (`image_too_small`, D6).
- **Library.** `listMedia` with `{ active: true }` in a project with Instagram and Bluesky accounts gives two platforms per item (AS5). With no active accounts there are none (AS6). Two Instagram accounts in `accountIds` give one Instagram entry (AS7). An account id from another project is ignored.
- **Unknown file.** A file that does not decode is refused at upload ("That file could not be read as an image.") and never gets a badge.

## 5. UI literal scan and repo health (SC-004, SC-007)

```sh
pnpm vitest run tests/lint/ui-limit-literals.test.ts tests/lint/import-boundaries.test.ts src/app/p/[projectSlug]/ui-conventions.test.ts
```

The scan expects no MIME string, counting-rule name or declared limit (≥ 100) as a literal in the composer, picker or media-library UI files.

Final pass, once, at the end of implement (constitution "Run checks in proportion"):

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm build` is included because a server component page and client component props change. `pnpm db:check` is not needed, since there is no schema change.

## 6. Manual walk (optional, mock accounts)

1. `pnpm dev`, then sign in and open a project with a mock account. Connecting real Instagram or Bluesky accounts is not needed for the summary: the provider fixtures in tests cover them.
2. Open **Compose** and select the account. Before typing, the preview card shows "What Mock accepts" with its limits.
3. Click **Add images**: each library image shows "Mock: fits" (or converted/refused, with the planner's sentence).
4. Open **Media**: the same badges show for the project's active accounts.
