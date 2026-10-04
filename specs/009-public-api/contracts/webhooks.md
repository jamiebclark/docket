# Contract: outgoing webhooks (events, signing, delivery section)

## Events

| `type` | Emitted when (in the changing transaction) | `data` |
|---|---|---|
| `post.published` | `applyDerivedStatus` writes `published` over a different stored status | `Post` (the `GET /posts/{id}` shape, with targets) |
| `post.failed` | `applyDerivedStatus` writes `failed` or `partially_failed` over a different stored status | `Post` |
| `job.finished` | `refreshJobStatus` writes `completed` or `completed_with_failures` over a different stored status, or `cancelJob` writes `cancelled` | `Job` (with counts) |
| `account.needs_reauth` | `accounts.recordRefresh` or `markCredentialsInvalid` moves an account from `active` to `needs_reauth` | `Account` |
| `ping` | "Send test event" | `{ endpointId }` |

The body is JSON:

```json
{
  "id": "evt uuid",
  "type": "post.published",
  "createdAt": "2026-10-04T10:00:00.000Z",
  "projectId": "uuid",
  "data": { }
}
```

The same `id` and `body` are used for every attempt and every resend (FR-036). Credentials, keys and secrets never appear: the presenters are the API's, which exclude them, and a no-secrets test scans event bodies.

## Emission

```ts
// services/webhooks/emit.ts
export type EmitRepos = Pick<ProjectScope, "webhooks" | "posts" | "targets" | "accounts" | "media">;
export async function emitEvent(tx: EmitRepos, type: WebhookEventType, subject: { postId } | { jobId } | { accountId }): Promise<void>;
```

1. `tx.webhooks.subscribedEndpointIds(type)` returns the enabled endpoints whose `events` contain `type`. An empty result → return. This is one indexed query, with no writes.
2. Build `data` with the shared presenter from `services/views/`. For a post, that reads post, targets, accounts, media and the project time zone (`tx.webhooks.projectTimeZone()`).
3. Insert one `webhook_events` row and one `webhook_deliveries` row per endpoint (`pending`, `next_attempt_at = now`).

**Hook-in points.** Each is a small, logged generic change:

- **`applyDerivedStatus(tx, postId)`**: after `setStatus`, if `status !== post.status` and `status ∈ {published, failed, partially_failed}`, it calls `emitEvent`. The parameter type widens to `EmitRepos`. Scheduler repos (`createSchedulingRepos`) gain `webhooks`, so every existing caller already passes a compatible object. The type checker confirms it.
- **`refreshJobStatus` and `cancelJob`**: as in the table above.
- **Accounts**: the DAL `recordRefresh` and `markCredentialsInvalid` return `{ changed: boolean; previousStatus: "active" | "needs_reauth" | null }`, where the old boolean is now `changed`. The call sites in `scheduler/credentials.ts`, `scheduler/token-refresh.ts` (two) and `scheduler/publishing.ts` run the call and, when `previousStatus === "active"` and the new status is `needs_reauth`, `emitEvent(tx, "account.needs_reauth", …)` inside one `forSchedulerProject(projectId).transaction`. The UPDATE uses:

  ```sql
  WITH prev AS (SELECT status FROM social_accounts WHERE project_id = $p AND id = $id FOR UPDATE)
  UPDATE social_accounts SET … WHERE … RETURNING (SELECT status FROM prev) AS previous_status
  ```

Lock order inside emitting transactions is unchanged: the post or job lock first (taken by the caller), then the account and media reads (no locks), then the event and delivery inserts (new rows). Inserts into new rows take no locks that other paths wait on, so no deadlock is added.

## Signing (FR-037)

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Docket-Webhooks/1` |
| `Docket-Event-Id` | event id |
| `Docket-Event-Type` | event type |
| `Docket-Timestamp` | Unix seconds at send time |
| `Docket-Signature` | `v1=<hex>`, or `v1=<hex new>,v1=<hex old>` during a rotation overlap |

`hex = HMAC_SHA256(key = secret as UTF-8, message = "<Docket-Timestamp>.<raw body bytes>")`, lowercase hex.

```ts
// services/webhooks/sign.ts (pure)
export function signatureHeader(secrets: readonly string[], timestamp: number, rawBody: string): string;
export function verifySignature(input: { header: string; secret: string; timestamp: string; rawBody: string; now: number; toleranceSeconds?: number }): boolean;
```

`verifySignature` does the following:

1. It parses every `v1=` entry and ignores other schemes.
2. It recomputes the HMAC.
3. It compares each entry with `timingSafeEqual` on equal-length buffers.
4. It returns false for a timestamp more than 300 s from `now`.

`docs/n8n.md` "Verifying webhook signatures" gives the same algorithm as an n8n Code node snippet and a plain Node snippet. A test extracts the Node snippet from the doc and runs it against a real delivery (FR-037, SC-007).

## Delivery section (`scheduler/webhooks.ts`)

```ts
export async function runWebhookDeliveries(ctx: { config: SchedulerConfig; tickId: string; startedAt: Date }): Promise<WebhookCounts>;
export interface WebhookCounts { sent: number; succeeded: number; failed: number; retried: number; skipped: number; purged: number }
```

1. **Recover**: deliveries in `delivering` whose `lease_until ≤ now` go back to `pending`. The attempt is counted, and an attempt row with `internal` ("Delivery was interrupted") is written. This is one bounded UPDATE (limit 50), `crossProject("scheduler: recover webhook deliveries")`.
2. **Claim**: in one transaction, `crossProject("scheduler: claim webhook deliveries")`:
   - select up to `WEBHOOK_TICK_MAX_DELIVERIES` (10) `pending` rows with `next_attempt_at ≤ now` whose endpoint is enabled, ordered by `next_attempt_at, created_at`, `FOR UPDATE SKIP LOCKED`;
   - set `status = 'delivering'`, `lease_owner = token`, `lease_until = now + SCHEDULER_LEASE_SECONDS`.

   Deliveries whose endpoint is disabled are marked `failed` (`endpoint_disabled`) in the same transaction.
3. **Send**: outside any transaction, with concurrency 4. Before each send it checks that `deadline − now ≥ 11 s`, else it releases the lease (back to `pending`, no attempt counted) and counts it as `skipped`. Each send:
   - reads the endpoint;
   - decrypts the current secret, and the previous one if its overlap has not ended;
   - serialises the body once;
   - signs it;
   - runs `fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(10_000) })`;
   - reads at most 1,000 characters of the response text, with a 2 s cap on reading.
4. **Record**: in one short transaction per delivery, with the lease-token check (zero rows → stale; write nothing more):
   - insert the attempt row;
   - on 2xx: `succeeded`, `finished_at`, endpoint `consecutive_failures = 0`;
   - on 410: `failed`, endpoint `enabled = false, disabled_reason = 'gone'`, and its other `pending` deliveries → `failed` (`endpoint_disabled`);
   - otherwise with `attempt_count < 8`: back to `pending`, `next_attempt_at = now + min(60 s × 2^(n−1), 6 h)`;
   - otherwise: `failed`, endpoint `consecutive_failures += 1`, and at ≥ 20 the endpoint is disabled as `failing`.
5. **Housekeeping** (bounded at 500 rows per statement, `crossProject`):
   - delete attempts and finished deliveries older than 30 days;
   - delete events older than 30 days with no deliveries;
   - `idempotency.purgeExpired`.
6. **Heartbeat**: write `webhooks`, as the other sections do.

`runTick()` runs this as a fourth independent section with the same `section()` wrapper. `TickSummary` gains `webhooks`, and the summary log line gains its counts. A failure never fails the other sections (FR-038).

Constants live in `scheduler/config.ts`: `webhookMaxPerTick` (10), `webhookConcurrency` (4), `webhookTimeoutMs` (10,000), `webhookMaxAttempts` (8), `webhookBackoffBaseMs` (60,000), `webhookBackoffMaxMs` (21,600,000), `webhookDisableAfterFailures` (20), `webhookRetentionDays` (30) and `webhookMinWindowMs` (11,000). Tests can override them through `runTick({ config })`, and the production values are logged in `docs/decisions.md`.

The worker bundle gains this section. `tests/lint/worker-bundle.test.ts` still passes, because it uses only `fetch`, `node:crypto` and the DAL.
