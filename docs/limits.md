# Platform limits

Every limit Docket knows about, where it is enforced, and the test that proves a request that breaks it never reaches the platform (FR-014, FR-018). `tests/integration/docs/limits-inventory.test.ts` checks this file against the registered providers' capabilities and declared publish limits, so it cannot drift.

How to read a row:

- **Category** is a fixed vocabulary (see the test): `text length`, `images`, `bytes per file`, `formats`, `min width`, `max width`, `min aspect`, `max aspect`, `alt text length`, `media required`, `text only`, `publish limit`, plus free-text `note:` rows.
- **Value** is what the provider declares. For `publish limit` it is `<count> / <window seconds> s`, or `none`.
- **Source** is a research file under `docs/research/`, or `interim, UNVERIFIED` with the decision that introduced it (`docs/decisions.md`). An approximate figure says so.
- **Enforced in** is the one place that refuses or defers: `validateResolvedContent` (shared by the scheduling gate and the publish engine, which re-checks on a target's first step and fails it on step `engine-validate`), the media planner (adapts or refuses before validation), or the engine's rate deferral (`deferralTime` in `src/server/scheduler/limits.ts`).
- **Test** is the file that proves it and, in quotes, the test that breaks exactly that limit with the provider's own values. In `tests/integration/limits/enforcement.test.ts` the tests are generated from each provider's capabilities and are named `<provider key>: <category>` (`<provider key>: publish limit <value>` for publish limits); a `none` publish limit is proved with an account-level limit, since that is the one that applies. Elsewhere the quoted text is part of a literal test title. The doc test checks both, and that the test sits in the suite for the row's enforcement point.

Nothing here is "unenforced". Media planner rows are adaptations or refusals (decision D15): an image of a type the provider does not accept is converted, an oversize one is compressed and a too-wide one is downscaled, while the planner's refusals (`image_too_small`, `aspect_ratio_out_of_range`, undecodable) are the enforced edge. Their tests drive `planImage` with `mediaConstraintsOf(provider.capabilities)`; generating the adapted file is tested in `src/server/media/variants.test.ts`.

## Facebook

| Category | Value | Counting | Source | Enforced in | Test |
|---|---|---|---|---|---|
| text length | 10000 | code points | interim, UNVERIFIED (decisions.md R1) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: text length" |
| images | 10 |  | interim, UNVERIFIED (decisions.md R2) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: images" |
| bytes per file | 8000000 |  | interim, UNVERIFIED (decisions.md R2) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: bytes per file" |
| formats | image/jpeg, image/png |  | interim, UNVERIFIED (decisions.md R2); an uploaded WebP (or an oversize PNG) is converted to JPEG | media planner | `tests/integration/limits/enforcement.test.ts` "facebook: formats" |
| media required | no |  | interim, UNVERIFIED (decisions.md R1–R10) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: media required" |
| text only | yes |  | interim, UNVERIFIED (decisions.md R1–R10) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "facebook: text only" |
| publish limit | none |  | no documented per-Page limit found; NEEDS RESEARCH (research U2). The account-level limit still applies | account limit (engine deferral) | `tests/integration/limits/enforcement.test.ts` "facebook: publish limit none" |

## Instagram

| Category | Value | Counting | Source | Enforced in | Test |
|---|---|---|---|---|---|
| text length | 2200 | code points | interim, UNVERIFIED (decisions.md R1) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: text length" |
| images | 10 |  | docs/research/meta.md (carousel max 10 items) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: images" |
| bytes per file | 8000000 |  | docs/research/meta.md (8 MB); oversize is compressed, not refused (D15) | media planner | `tests/integration/limits/enforcement.test.ts` "instagram: bytes per file" |
| formats | image/jpeg |  | docs/research/meta.md (JPEG only); an uploaded PNG or WebP is converted to JPEG | media planner | `tests/integration/limits/enforcement.test.ts` "instagram: formats" |
| max width | 1440 |  | docs/research/meta.md (320–1440, scaled outside); wider is downscaled, narrower is accepted (D15) | media planner | `tests/integration/limits/enforcement.test.ts` "instagram: max width" |
| min aspect | 0.8 |  | docs/research/meta.md (4:5) | media planner | `tests/integration/limits/enforcement.test.ts` "instagram: min aspect" |
| max aspect | 1.91 |  | docs/research/meta.md (1.91:1) | media planner | `tests/integration/limits/enforcement.test.ts` "instagram: max aspect" |
| alt text length | 1000 |  | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: alt text length" |
| media required | yes |  | docs/research/meta.md (no text-only posts) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: media required" |
| text only | no |  | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "instagram: text only" |
| publish limit | 100 / 86400 s |  | docs/research/meta.md (100 API-published posts per rolling 24 h) | engine deferral | `tests/integration/limits/enforcement.test.ts` "instagram: publish limit 100 / 86400 s" |

## Threads

| Category | Value | Counting | Source | Enforced in | Test |
|---|---|---|---|---|---|
| text length | 500 | UTF-8 bytes for emoji (custom rule) | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "threads: text length" |
| images | 20 |  | docs/research/meta.md (carousel 2–20 items) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "threads: images" |
| bytes per file | 8000000 |  | docs/research/meta.md (8 MB); oversize is compressed, not refused (D15) | media planner | `tests/integration/limits/enforcement.test.ts` "threads: bytes per file" |
| formats | image/jpeg, image/png |  | docs/research/meta.md; an uploaded WebP (or an oversize PNG) is converted to JPEG | media planner | `tests/integration/limits/enforcement.test.ts` "threads: formats" |
| min width | 320 |  | docs/research/meta.md | media planner | `tests/integration/limits/enforcement.test.ts` "threads: min width" |
| max width | 1440 |  | docs/research/meta.md | media planner | `tests/integration/limits/enforcement.test.ts` "threads: max width" |
| min aspect | 0.1 |  | docs/research/meta.md (aspect ≤10:1) | media planner | `tests/integration/limits/enforcement.test.ts` "threads: min aspect" |
| max aspect | 10 |  | docs/research/meta.md (aspect ≤10:1) | media planner | `tests/integration/limits/enforcement.test.ts` "threads: max aspect" |
| alt text length | 1000 |  | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "threads: alt text length" |
| media required | no |  | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "threads: media required" |
| text only | yes |  | docs/research/meta.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "threads: text only" |
| publish limit | 250 / 86400 s |  | docs/research/meta.md (250 posts / 24 h) | engine deferral | `tests/integration/limits/enforcement.test.ts` "threads: publish limit 250 / 86400 s" |
| note: carousel minimum | 2 |  | docs/research/meta.md; one image publishes as an image post (D15) | post type inference | `tests/integration/threads/publish-e2e.test.ts` "publishes one image through IN_PROGRESS then FINISHED" |

## Bluesky

| Category | Value | Counting | Source | Enforced in | Test |
|---|---|---|---|---|---|
| text length | 300 | graphemes (and 3000 bytes, `validateBluesky`) | docs/research/bluesky.md (lexicon) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "bluesky: text length" |
| images | 4 |  | docs/research/bluesky.md (lexicon) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "bluesky: images" |
| bytes per file | 2000000 |  | docs/research/bluesky.md (lexicon, not 2 MiB) | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "bluesky: bytes per file" |
| formats | image/jpeg, image/png |  | docs/research/bluesky.md (`image/*`); an uploaded WebP (or an oversize PNG) is converted to JPEG | media planner | `tests/integration/limits/enforcement.test.ts` "bluesky: formats" |
| media required | no |  | docs/research/bluesky.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "bluesky: media required" |
| text only | yes |  | docs/research/bluesky.md | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "bluesky: text only" |
| publish limit | 1666 / 3600 s |  | approximate (research U3; docs/research/bluesky.md: 5,000 points/hour, a create costs 3, so `floor(points ÷ 3)`); points are shared with any other app writing to the account (decisions.md G16) | engine deferral | `tests/integration/limits/enforcement.test.ts` "bluesky: publish limit 1666 / 3600 s" |
| publish limit | 11666 / 86400 s |  | approximate (research U3; 35,000 points/day, `floor(points ÷ 3)`); decisions.md G16 | engine deferral | `tests/integration/limits/enforcement.test.ts` "bluesky: publish limit 11666 / 86400 s" |
| note: login rate | createSession 30 / 5 min and 300 / day |  | docs/research/bluesky.md | publishing never creates a session; it reuses and refreshes the stored one | `tests/integration/limits/enforcement.test.ts` "Bluesky publishing does not create a session" |

## Mock (offline)

| Category | Value | Counting | Source | Enforced in | Test |
|---|---|---|---|---|---|
| text length | 500 | graphemes | test double, not a platform | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: text length" |
| images | 4 |  | test double | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: images" |
| bytes per file | 5000000 |  | test double | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: bytes per file" |
| formats | image/jpeg, image/png |  | test double | media planner | `tests/integration/limits/enforcement.test.ts` "mock: formats" |
| media required | no |  | test double | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: media required" |
| text only | yes |  | test double | validateResolvedContent | `tests/integration/limits/enforcement.test.ts` "mock: text only" |
| publish limit | none |  | test double; the account-level limit still applies | account limit (engine deferral) | `tests/integration/limits/enforcement.test.ts` "mock: publish limit none" |

## Audit notes (T032)

Gaps found when each provider's declared limits were read against `docs/research/`:

- **Bluesky declared no publish limit** although research lists write points. Fixed: two approximate limits, decisions.md G16 (U3).
- **Facebook declares no publish limit** and `docs/research/meta.md` has none for Pages. NEEDS RESEARCH (U2); the account-level limit is the only guard.
- **Bluesky formats** are declared as JPEG/PNG while the lexicon accepts `image/*`. This is deliberate: anything else is refused at upload as an unsupported type.
- **Instagram minimum width 320** is not declared; research says the platform scales up from below 320, so Docket accepts it (D15).
- **Facebook, Instagram and Threads text lengths and Facebook photo values** are interim and UNVERIFIED against the live API (decisions.md R1–R10); they are enforced as declared.
- **Bluesky login rate** is not a capability; it is met by never logging in at publish time (FR-019).
- **Publish-time re-validation** was missing before G15 (research F15) and is now in the engine.
