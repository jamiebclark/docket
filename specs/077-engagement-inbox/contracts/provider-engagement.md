# Contract: the engagement provider capability

**Feature**: `077-engagement-inbox` | Added to `src/providers/types.ts`

One optional member on `SocialProvider`. A provider opts in by declaring what it can read and
whether it can reply, and by implementing two functions. **Nothing outside the provider's own folder
changes when a platform is added** (constitution V, SC-012): not the inbox, not the drafting, not
the review path, not the notifications, not the activity log, not the schema.

```ts
export type EngagementItemKind = "reply" | "comment" | "mention" | "direct_message";

export interface EngagementDeclaration {
  /** Inbound kinds this provider can read. Empty is not allowed — omit `engagement` instead. */
  reads: readonly EngagementItemKind[];
  /** Whether an inbound item can be answered on this platform. */
  canReply: boolean;
  /** The per-account write allowance a reply spends, for the publishing-first reserve (FR-042). */
  writeBudget?: PublishLimit;
  /**
   * Set when a surface is known to need a permission the install cannot hold (FR-055).
   * Declared surfaces still appear, marked unavailable with this reason and a link — and no call
   * is ever made for them.
   */
  unavailable?: { reason: string; docsPath?: string };
}

export interface EngagementSupport<Settings = unknown> {
  declaration: EngagementDeclaration;
  /** Provider-owned shape of `engagement_items.provider_data`; the generic layer never reads it. */
  itemDataSchema: z.ZodType;
  /** Provider-owned shape of `engagement_account_states.provider_state`. */
  stateSchema: z.ZodType;
  read(ctx: EngagementReadContext<Settings>): Promise<EngagementReadResult>;
  send(ctx: EngagementSendContext<Settings>): Promise<EngagementSendResult>;
}

export interface SocialProvider<Settings = unknown, State = unknown> {
  // … unchanged …
  engagement?: EngagementSupport<Settings>;
}
```

## Reading

```ts
export interface EngagementReadContext<Settings> {
  account: { id: string; externalId: string; displayName: string; settings: Settings; credentials: unknown };
  /** null = read the newest page. */
  cursor: string | null;
  /** Parsed through `stateSchema`; `{}` on the first read. */
  providerState: unknown;
  /** Which direction this call is paging. */
  direction: "newest" | "older";
  limit: number;
  now: Date;
  signal: AbortSignal;
}

export interface InboundItemDraft {
  kind: EngagementItemKind;
  externalId: string;            // 1–200 chars, trimmed, stable for this item on this platform
  text: string;                  // "" when the item carries no text; never a placeholder
  textTruncated?: boolean;
  author: {
    displayName: string | null;  // null means the platform supplied none (FR-016)
    handle: string | null;
    externalId: string | null;
    url: string | null;
    /** false whenever the provider cannot promise the same person twice (FR-017). */
    identityStable: boolean;
    reachable?: boolean;         // default true
  };
  saidAt: Date;
  parentExternalId: string | null;
  /** Validated against `itemDataSchema`; must contain no credential or token (FR-062). */
  data?: unknown;
  /** The platform reported the original gone or changed (FR-011). */
  upstream?: "withdrawn" | "edited";
}

export type EngagementReadResult =
  | { kind: "page"; items: readonly InboundItemDraft[]; cursor: string | null;
      providerState?: unknown; exhausted: boolean; summary?: AttemptSummary }
  | { kind: "retryable_error"; error: string; retryAt?: Date }
  | { kind: "fatal_error"; error: string }
  | { kind: "credentials_invalid"; error: string }
  | { kind: "rate_limited"; error: string; retryAt?: Date }
  | { kind: "cursor_lost"; error: string }
  | { kind: "unavailable"; reason: string; docsPath?: string };
```

**Rules a provider must obey**

1. **Never throws.** Every failure is a result, as `advance()` already is.
2. **Pure of policy.** It returns one page; the paging policy, the per-run bound and the cursor
   bookkeeping belong to the scheduler (data-model.md §7).
3. **Invents nothing.** An absent display name is `null`, not the handle; an absent handle is `null`,
   not the identifier. `identityStable: false` whenever the platform's identifier cannot be trusted
   to be the same person twice.
4. **No side effect on the platform.** Reading must not mark anything read, seen, hidden or handled.
   (For Bluesky this is explicit: `app.bsky.notification.updateSeen` is never called —
   research.md §6.)
5. **No live calls in tests.** Every path, including the error and `cursor_lost` paths, is covered
   with mocked HTTP.
6. **`exhausted: true`** means the platform has nothing older; the scheduler then clears the backfill
   flag.

## Sending

```ts
export interface EngagementSendContext<Settings> {
  account: { id: string; externalId: string; settings: Settings; credentials: unknown };
  item: { kind: EngagementItemKind; externalId: string; parentExternalId: string | null; data: unknown };
  text: string;
  now: Date;
  signal: AbortSignal;
}

export type EngagementSendResult =
  | { kind: "sent"; externalId: string; url?: string; summary?: AttemptSummary }
  | { kind: "duplicate"; externalId?: string }          // the platform says it is already answered
  | { kind: "retryable_error"; error: string; retryAt?: Date }
  | { kind: "fatal_error"; error: string; flagAccount?: boolean }
  | { kind: "credentials_invalid"; error: string }
  | { kind: "ambiguous"; error: string };
```

**Rules**

1. **One platform write per call.** No multi-step state machine: a reply is one write, so the step
   machine publishing needs has no counterpart here.
2. **Any uncertainty is `ambiguous`.** A timeout, an unparseable answer, or a 2xx that does not name
   the created reply is `ambiguous`, never `retryable_error`. This is constitution V's rule applied
   unchanged: a duplicate reply to a real person reads worse than a late one.
3. **`fatal_error` means nothing was sent** and the platform said so definitively. Only that answer
   releases the ledger for another attempt (research.md §3). `flagAccount` is set when the cause is a
   credential or permission problem, and the account is flagged exactly as a failed publish flags it.
4. **`duplicate` is a success**: the item is marked answered.
5. The text handed to `send` is already counted against `capabilities.text` by the service; the
   provider does not re-validate it, exactly as `advance()` trusts the validated content today.

## What the generic layer promises the provider

- Credentials are decrypted and, if `needsRefresh`, refreshed through the existing serialised refresh
  before the call (`refreshForPublish`), so a provider never implements refreshing twice.
- The call happens outside any database transaction, under `signal` with the tick's provider timeout.
- `providerState` and `data` are round-tripped through the provider's own Zod schemas; anything that
  fails to parse is treated as absent, never as an error for the whole account.
- The item is already stored before `send` is called, and the ledger claim is already committed.

## Bluesky, the one implementation in this entry

| Contract | Bluesky |
|---|---|
| `declaration.reads` | `["reply", "mention"]` (FR-054). `comment` and `direct_message` are not declared |
| `declaration.canReply` | `true` |
| `declaration.writeBudget` | `{ count: 1666, windowSeconds: 3600 }` — floor(5,000 points/hour ÷ 3 per create), from `docs/research/bluesky.md` |
| `read` | `app.bsky.notification.listNotifications({ reasons: ["reply","mention"], limit, cursor })`, mapping `uri`, `cid`, `author.{did,handle,displayName}`, `record.text`, `record.createdAt`, `reasonSubject`/`record.reply.parent.uri` |
| `itemDataSchema` | `{ cid: string, root?: { uri: string, cid: string } }` — the strong refs a reply needs |
| `send` | `com.atproto.repo.createRecord` with `app.bsky.feed.post` and `reply: { root, parent }`, parent = the item itself; the existing `AtUri` check decides `sent` vs `ambiguous`, as `createPost` already does |
| `identityStable` | `true` — a `did` is stable (research.md §6) |
| `unavailable` | not set |

The mock provider declares all four kinds plus an `unavailable` variant, so the inbox's
"unavailable with a reason, and no call made" path (FR-055) and the DM presentation (FR-056) are
tested without a Meta app.
