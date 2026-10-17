# Contract: `SocialProvider.insights` — generic change G30

**Feature**: 079-insights-core-bluesky | **File**: `src/providers/types.ts`

One new optional member on `SocialProvider`. A provider that omits it is absent from the poller and
from the panel with no error anywhere (FR-001), and **no code outside `src/providers/` may name a
provider key or a platform metric key to decide anything** (FR-001, FR-002, SC-013).

`src/providers/**` must not import from `src/server/**`, so nothing here references a DAL type, a
schema row or scheduler config (FR-012). `tests/lint/import-boundaries.test.ts` enforces it.

---

## 1. The declaration

```ts
/** One metric a platform reports, named with the platform's own word (G30, FR-002). */
export interface MetricKeyDeclaration {
  /** The platform's own field name, e.g. `likeCount`. Stored verbatim as a key in `metrics`. */
  key: string;
  /** The platform's own label, e.g. "Likes". Rendered as given; never translated or grouped. */
  label: string;
}

export interface InsightsDeclaration {
  /** Keys this platform reports for a post. Empty is allowed only when `account` is not. */
  post: readonly MetricKeyDeclaration[];
  /** Keys this platform reports for a connected account. */
  account: readonly MetricKeyDeclaration[];
  /** Most posts the platform will answer for in one `readPostMetrics` call (FR-006). */
  maxPostsPerRead: number;
  /** The per-account read allowance, for the publishing-first reserve (FR-007). */
  readBudget: PublishLimit;
  /**
   * Set when the surface is known to need a permission this install cannot hold (FR-003).
   * A provider that declares this is **never claimed**: no call is ever attempted, and the panel
   * shows `reason` with a link to `docsPath`.
   */
  unavailable?: { reason: string; docsPath?: string };
}

export interface InsightsSupport<Settings = unknown> {
  declaration: InsightsDeclaration;
  /** Provider-owned shape of a post snapshot's `metrics`; the generic layer validates and never reads into it. */
  postMetricsSchema: z.ZodType;
  /** Provider-owned shape of an account snapshot's `metrics`. */
  accountMetricsSchema: z.ZodType;
  readPostMetrics(ctx: PostMetricsReadContext<Settings>): Promise<PostMetricsReadResult>;
  readAccountMetrics(ctx: AccountMetricsReadContext<Settings>): Promise<AccountMetricsReadResult>;
}

export interface SocialProvider<Settings = unknown, State = unknown> {
  /* …unchanged… */
  insights?: InsightsSupport<Settings>;
}
```

### Rules on the declaration

| # | Rule | Requirement |
|---|---|---|
| D1 | A declaration with `post` and `account` both empty and no `unavailable` is **rejected at registry load**, by `assertInsightsDeclaration` beside `assertCreationAllowance` in `src/providers/registry.ts`. The way to report nothing is to omit `insights` | FR-004 |
| D2 | Keys within `post`, and within `account`, are unique; a key is `[A-Za-z][A-Za-z0-9_]{0,50}`; a label is 1–40 characters, trimmed, non-empty. Violations are rejected at registry load | FR-002 |
| D3 | `maxPostsPerRead` is an integer in `[1, 200]`. Rejected at registry load otherwise | FR-006 |
| D4 | `readBudget.count >= 1` and `readBudget.windowSeconds` in `[1, 604800]` | FR-007 |
| D5 | `unavailable.reason` is 1–300 characters of plain text with no credential; `docsPath` is a page name on the published docs site | FR-003 |
| D6 | Both schemas must reject anything resembling a credential or token: each is a closed `z.object` of optional `z.number()` fields, so a string value cannot pass at all | FR-005 |
| D7 | The generic layer defines **no** metric key of its own and never maps, aliases, translates or groups one | FR-002 |

A declared key is **not** a promise the platform answers: a key the provider declares and the
platform never returns is simply absent from every snapshot and from the panel (FR-064, spec edge
case). The reverse is forbidden: a key the provider returns but never declared is **dropped before
storage** (FR-018).

## 2. Reading a batch of posts

```ts
export interface PostMetricsReadContext<Settings = unknown> {
  account: { id: string; externalId: string; displayName: string; settings: Settings; credentials: unknown };
  /** One account's targets, at most `min(configured page size, maxPostsPerRead)` of them. */
  posts: readonly { externalId: string }[];
  now: Date;
  signal: AbortSignal;
}

export type PostMetricEntry =
  /** `metrics` is validated against `postMetricsSchema` by the caller, then filtered to declared keys. */
  | { externalId: string; kind: "metrics"; metrics: unknown }
  /** The platform no longer returns this post. Terminal for this target; **not** a failure (FR-042). */
  | { externalId: string; kind: "gone" };

export type PostMetricsReadResult =
  | { kind: "page"; entries: readonly PostMetricEntry[]; summary?: AttemptSummary }
  | { kind: "retryable_error"; error: string; retryAt?: Date }
  | { kind: "fatal_error"; error: string }
  | { kind: "credentials_invalid"; error: string }
  | { kind: "rate_limited"; error: string; retryAt?: Date }
  | { kind: "unavailable"; reason: string; docsPath?: string };
```

| # | Rule | Requirement |
|---|---|---|
| R1 | `readPostMetrics` takes **one account plus a batch of its targets**, never a single target | FR-008 |
| R2 | A `page` result carries **exactly one entry per requested `externalId`**, in any order, with no duplicates and no id that was not requested. The caller treats a missing or unexpected id as a `fatal_error` | FR-008 |
| R3 | The result vocabulary is exactly the six kinds above — `EngagementReadResult`'s minus `cursor_lost`. No new error word may be introduced | FR-010 |
| R4 | Neither call may **throw**. Every platform failure, timeout, abort and parse failure maps to one of the five non-`page` kinds | FR-011 |
| R5 | Neither call may have **any** side effect on the platform: no mark-as-seen, no write, no state change on the account | FR-011 |
| R6 | `error` and `reason` are plain text, at most 300 characters, and carry no token, credential, URL fragment or header value. The caller redacts again against the account's own secret values before storing (FR-041) — belt and braces, not an excuse | FR-057, FR-075 |
| R7 | `signal` is honoured: a provider passes it to its HTTP call so a tick out of budget aborts rather than overrunning | FR-035 |

## 3. Reading an account

```ts
export interface AccountMetricsReadContext<Settings = unknown> {
  account: { id: string; externalId: string; displayName: string; settings: Settings; credentials: unknown };
  now: Date;
  signal: AbortSignal;
}

export type AccountMetricsReadResult =
  | { kind: "page"; metrics: unknown; summary?: AttemptSummary }
  | { kind: "retryable_error"; error: string; retryAt?: Date }
  | { kind: "fatal_error"; error: string }
  | { kind: "credentials_invalid"; error: string }
  | { kind: "rate_limited"; error: string; retryAt?: Date }
  | { kind: "unavailable"; reason: string; docsPath?: string };
```

Same rules R3–R7. There is no `gone` entry: an account Docket holds credentials for either answers
or fails (FR-009).

## 4. What the caller does, so a provider need not

The scheduler section, not the provider, is responsible for:

1. **Validating** `metrics` against the provider's own schema; a failure is counted as a failed read
   with the stated reason and **no partial row written** (spec edge case).
2. **Dropping undeclared keys** before storage (FR-018).
3. **Batching** at `min(INSIGHTS_READ_PAGE_SIZE, declaration.maxPostsPerRead)` (FR-034).
4. **The allowance reserve** (FR-045) — a provider never sees it.
5. **Redaction, backoff, leases, freezing and counts** (FR-040 … FR-043).
6. **Never calling a provider whose declaration is `unavailable`** — the claim excludes its provider
   key, so no call is attempted in any tick (FR-003).

## 5. The Bluesky implementation (`src/providers/bluesky/insights.ts`)

```ts
export const blueskyInsights: InsightsSupport<BlueskySettings> = {
  declaration: {
    post: [
      { key: "likeCount",   label: "Likes" },
      { key: "repostCount", label: "Reposts" },
      { key: "replyCount",  label: "Replies" },
      { key: "quoteCount",  label: "Quotes" },
    ],
    account: [
      { key: "followersCount", label: "Followers" },
      { key: "followsCount",   label: "Following" },
      { key: "postsCount",     label: "Posts" },
    ],
    maxPostsPerRead: 25,                                   // the lexicon's own maxLength (FR-053)
    readBudget: { count: 1_666, windowSeconds: 3_600 },    // interim, UNVERIFIED (research §3)
  },
  postMetricsSchema: z.object({
    likeCount: z.number().int().optional(),
    repostCount: z.number().int().optional(),
    replyCount: z.number().int().optional(),
    quoteCount: z.number().int().optional(),
  }).strict(),
  accountMetricsSchema: z.object({
    followersCount: z.number().int().optional(),
    followsCount: z.number().int().optional(),
    postsCount: z.number().int().optional(),
  }).strict(),
  readPostMetrics,
  readAccountMetrics,
};
```

**No `views` key and no `reach` key** (FR-052): `PostView` and `ProfileViewDetailed` have no such
property — a confirmed negative, research §1.

`readPostMetrics` calls
`agentFor(settings.pdsUrl, creds.accessJwt).app.bsky.feed.getPosts({ uris }, { signal })`, then for
each requested `uri` emits `{ kind: "metrics", metrics }` carrying **only the count fields the
response actually contained** (FR-054 — an omitted count is omitted, never defaulted to zero), or
`{ kind: "gone" }` when that `uri` is absent from `res.data.posts` (FR-055).

`readAccountMetrics` calls `app.bsky.actor.getProfile({ actor: account.externalId })` — the DID
(FR-051) — and emits whichever of the three counts the response contained.

Error mapping, through the provider's existing helpers in `src/providers/bluesky/errors.ts`
(FR-057):

| Platform outcome | Result | Helper |
|---|---|---|
| 429 | `rate_limited` with `retryAt` from the reset header | `rateLimitNotBefore(err.headers, now)` |
| 401, or 400 `ExpiredToken` | `credentials_invalid` | `isCredentialRejection(err)` |
| >= 500, or status 1/2 (no response, invalid response) | `retryable_error` | `safeReason(err)` |
| unreachable host (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) | `retryable_error` | `isPreSend(err)` |
| any other 4xx | `fatal_error` | `safeReason(err)` |
| credentials unparseable | `credentials_invalid` | `blueskyCredentialsSchema.safeParse` |
| schema parse failure on the response | `fatal_error` | — |

No message carries any part of a token: `safeReason` yields the platform error name and status only.
Verified with **mocked HTTP only** until the live check runs (FR-058, constitution II).

## 6. The mock implementation (`src/providers/mock/insights.ts`)

The fixture every scheduler and UI test uses, scripted per account through `mockSettingsSchema`
(FR-059 … FR-061). New settings fields:

| Field | Type | Scripts |
|---|---|---|
| `insightsUnavailable` | boolean, default false | the `unavailable` declaration — proves no call is ever made |
| `insightsPostMetrics` | record of key → number, default `{ likeCount: 4, repostCount: 1 }` | the values a post read returns |
| `insightsAccountMetrics` | record of key → number, default `{ followersCount: 100 }` | the values an account read returns |
| `insightsGoneExternalIds` | string array, default `[]` | these ids come back `kind: "gone"` |
| `insightsPostReadBehaviour` | enum of the five stop kinds plus `page`, default `page` | each non-`page` outcome |
| `insightsAccountReadBehaviour` | same enum, default `page` | — |
| `insightsReturnUndeclaredKey` | boolean, default false | a response holding a key the declaration omits — must be dropped |
| `insightsOversizedPayload` | boolean, default false | a payload over the 2,000-byte size check — must be refused with no partial row |

The mock declares post keys `likeCount`/"Likes", `repostCount`/"Reposts", `viewCount`/"Views" (a key
Bluesky has no equivalent of, so a cross-platform assumption in shared code would fail a test) and
account keys `followersCount`/"Followers", `postsCount`/"Posts". `maxPostsPerRead: 3`, so batching
across several calls is exercisable with four fixture targets.

Every one of the eight honest panel states and every stop result in the vocabulary is reachable from
these settings alone, with no platform credentials (SC-004).
