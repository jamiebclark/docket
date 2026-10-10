# Driving Docket from n8n (or any HTTP client)

Docket's public API lets an n8n workflow do what the old scheduler flow did: take a row (an image URL and a brief), import the image, generate a post for each account, and queue it into the next free slot. Re-running the same rows creates nothing new, because every write carries a row-derived idempotency key.

The full reference is generated from the code: `/api/v1/openapi.json` on your Docket host.

## 1. Create a key

In the project, open **Settings → API keys → Create key**. For this flow tick `read`, `write_posts`, `generate` and `auto_approve`. Pick a rate limit (60 a minute is plenty; the flow makes three calls per row) and an expiry. The secret (`dkt_…`) is shown once. Copy it into n8n straight away.

## 2. n8n credential

Create a **Header Auth** credential: name `Authorization`, value `Bearer dkt_…`. Use it on every HTTP Request node. (`X-API-Key: dkt_…` also works.) Keep the secret out of workflow JSON you share.

## 3. The flow

Per row, three requests. The blocks below are the exact requests; `{{…}}` are template variables. In n8n use expressions in place of the double braces.

| Variable | Meaning |
|---|---|
| `{{base}}` | your Docket origin, e.g. `https://docket.example.com` |
| `{{key}}` | the API key secret |
| `{{row.id}}` | a stable id for the row (sheet row id, record id). The idempotency keys derive from it |
| `{{row.imageUrl}}`, `{{row.alt}}`, `{{row.brief}}` | the row's data |
| `{{accountId}}` | the account to post to (list them with `GET /api/v1/accounts`) |
| `{{media.id}}`, `{{post.id}}` | `id` from step 1's response, and `post.id` from step 2's |

### Step 1 — import the image

```http
POST {{base}}/api/v1/media/from-url
Authorization: Bearer {{key}}
Content-Type: application/json
Idempotency-Key: media-{{row.id}}

{"url":"{{row.imageUrl}}","altText":"{{row.alt}}"}
```

### Step 2 — generate the post

```http
POST {{base}}/api/v1/generate
Authorization: Bearer {{key}}
Content-Type: application/json
Idempotency-Key: generate-{{row.id}}

{"brief":"{{row.brief}}","accountIds":["{{accountId}}"],"mediaIds":["{{media.id}}"],"approvalPolicy":"auto_approve","schedulingPolicy":"leave_as_draft"}
```

`auto_approve` needs the `auto_approve` permission. To generate and queue in this one call, send `"schedulingPolicy":"add_to_queue","confirmUnreviewedQueue":true`; then skip step 3.

### Step 3 — queue it

```http
POST {{base}}/api/v1/posts/{{post.id}}/queue
Authorization: Bearer {{key}}
Content-Type: application/json
Idempotency-Key: queue-{{row.id}}

{}
```

The response lists a result per target: the slot time it took, or a code such as `no_active_slots` or `not_queueable`. Each post lands in its own slot, so three rows give three different times.

## 4. Retries and errors

Set the HTTP Request node to retry on failure (3 tries, 2–5 seconds apart) and **always** keep the same `Idempotency-Key` across retries: a retry then replays the first answer (header `Idempotent-Replayed: true`) instead of acting twice.

| Status | Code | What to do |
|---|---|---|
| 409 | `idempotency_in_progress` | The first attempt is still running. Wait for `Retry-After` seconds and retry with the same key |
| 409 | `conflict` with `details.reason` | A recovery call was refused and nothing was written. `publishing`: wait and retry. `not_failed` or `already_resolved`: nothing to do. `account_removed`, `needs_reconnecting`, `provider_unavailable`, `cannot_publish`: alert a person |
| 422 | `idempotency_key_reused` | The same key was sent with a different body. Fix the key derivation. Do not retry as is |
| 422 | `generation_failed` | The model's output was unusable. Retry with a **new** key (for example `generate-{{row.id}}-2`) |
| 429 | `rate_limited` | Wait for `Retry-After` seconds, then retry the same request |
| 503 | `generation_unavailable`, `generation_not_configured` | The model is down or not set up. Retrying the same key later is safe |

Other 4xx answers are mistakes in the request; the body is `{"error":{"code","message","details","requestId"}}`. Quote `requestId` when asking for help.

## 5. Optional: start on `post.published`

Instead of polling, add a webhook endpoint in **Settings → Webhooks** and point it at an n8n **Webhook** node. Subscribe to `post.published` (and `post.failed` if you want alerts). Deliveries are signed. Verify the signature before trusting the body.

## 6. Verifying webhook signatures

Every delivery carries `Docket-Timestamp` (Unix seconds) and `Docket-Signature` (`v1=<hex>`; during a secret rotation overlap it holds two entries, `v1=<new>,v1=<old>`).

The signature is `HMAC_SHA256(secret, "<timestamp>.<raw body>")` as lowercase hex. To verify:

1. Use the **raw** body bytes, not re-serialised JSON.
2. Reject a timestamp more than 5 minutes (300 s) from your clock.
3. Recompute the HMAC and compare with each `v1=` entry in constant time.

```js
const crypto = require("node:crypto");

function verify({ header, secret, timestamp, rawBody, now = Math.floor(Date.now() / 1000) }) {
  if (Math.abs(now - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return String(header)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const given = Buffer.from(part.slice(3), "hex");
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
}

module.exports = verify;
```

In an n8n **Code** node, enable raw body on the Webhook node, then call the same function with `$json.headers["docket-signature"]`, `$json.headers["docket-timestamp"]` and the raw body string.

## 7. Recover failed posts

Retry and resolve are available over the API with a key holding `write_posts`. Build the flow like this:

1. Subscribe a webhook endpoint to `post.failed` and verify the signature (section 6).
2. `GET {{base}}/api/v1/posts/{{postId}}` and look at each target's `status`.
3. For each target that is `failed`, call retry with an `Idempotency-Key` derived from the event id and the target id, so a redelivered event replays instead of retrying twice:

```http
POST {{base}}/api/v1/posts/{{postId}}/targets/{{targetId}}/retry
Authorization: Bearer {{key}}
Content-Type: application/json
Idempotency-Key: retry-{{event.id}}-{{targetId}}

{"mode":"now"}
```

`mode` is `now` (publish on the next tick), `requeue` (next free slot; send `expected` to learn whether the time moved) or `at` (an RFC 3339 instant with an offset). A refusal such as `no_active_slots` comes back as `200` with `status: "failed"` and a `reason`.

   **Cap the retries.** Keep your own counter per `targetId` (for example in n8n workflow static data), stop after N tries (say 3) and alert a person. Docket's attempt count cannot serve as the limit: it resets on every retry, and each `post.failed` event has a new event id, so every retry gets a new `Idempotency-Key`.

4. **Never retry an `ambiguous` target.** Docket does not know whether it was published. Alert a person, or resolve it with `POST …/targets/{{targetId}}/resolve` and `{"outcome":"published","url":"…"}` or `{"outcome":"not_published","requeue":true}` once someone has checked the platform.
5. To retry everything at once, call `POST {{base}}/api/v1/targets/retry-failed` with `{"mode":"now"}` (add `accountId` to limit it to one account). Each call handles a capped batch. While the answer shows `remaining > 0`, call again with a **new** `Idempotency-Key`, because the same key replays the first answer.

The action is recorded in the attempt log as "API key {name}". Branch on the 409 `details.reason` values listed in section 4.

## 8. Read activity

`GET {{base}}/api/v1/activity` lists what happened to publishing, newest first, with a key holding `read`:

```http
GET {{base}}/api/v1/activity?outcome=problems&range=7d&limit=100
Authorization: Bearer {{key}}
```

Filters: `outcome` (repeatable or comma-separated; the seven outcomes, or the presets `successes` and `problems`), `platform`, `account`, `from` and `to` (`YYYY-MM-DD`, in the project's time zone) or `range` (`today`, `7d`, `30d`), `limit` (1–100) and `cursor`. A bad value is a `400` naming each field.

Each event has `outcome`, `message`, `occurredAt`, `platform`, `account`, `post` (with `excerpt`) and `actor`. Page with `nextCursor` until it is `null`.

**To poll for new events**, re-read from your last `occurredAt` (`from=` takes a day, so start from that day), then drop ids you have already seen. A walk can miss an event that commits after the page it belongs to was read, so overlap rather than start exactly after the last one. Branch on `outcome`, not on the message text.

## 9. Post each record once

If your source system (a CRM, a spreadsheet, a CMS) has its own id for each record, tag your submission with it and Docket guarantees that record is posted at most once, ever — even if your flow re-runs the whole backlog.

Add `externalId` (the record's id) and, if you pull from more than one system, `sourceKey` (which system it belongs to; defaults to `"default"`) to the generate request:

```http
POST {{base}}/api/v1/generate
Authorization: Bearer {{key}}
Content-Type: application/json
Idempotency-Key: generate-{{row.id}}

{"brief":"{{row.brief}}","accountIds":["{{accountId}}"],"externalId":"{{row.id}}","sourceKey":"crm"}
```

The first call for a given `(sourceKey, externalId)` generates and posts normally (`201`, `alreadyPosted: false`). Every later call for that same id — from this flow, a re-run, or a different API key entirely — answers `200` with the post Docket already made and `alreadyPosted: true`, and makes no model call. Treat `alreadyPosted: true` as success: skip step 3 (it is already queued) and move on.

If the post that claimed an id is later deleted, the id does not free up: a resubmission answers `409 conflict` with `details.reason: "already_posted_post_deleted"` rather than posting again. Branch on that reason to alert a person instead of retrying.

An id is only consumed once a post exists for it. A call that fails — the model's output was unusable, no model is configured, or the run was cancelled — claims nothing, so resubmitting the same `externalId` after fixing the problem posts normally; follow the retry guidance in section 4 for the underlying error.

For a backlog, send the whole batch through a job instead of one generate call per row: declare `source.sourceKey` once and set `externalId` on each item. Already-posted ids are dropped silently and counted, never re-posted:

```http
POST {{base}}/api/v1/jobs
Authorization: Bearer {{key}}
Content-Type: application/json
Idempotency-Key: job-{{batch.id}}

{"voiceProfileId":"{{voiceProfileId}}","accountIds":["{{accountId}}"],"template":"{{brief}}","source":{"kind":"api","fields":["brief"],"sourceKey":"crm","items":[{"fields":{"brief":"Row one"},"externalId":"row-1"},{"fields":{"brief":"Row two"},"externalId":"row-2"}]}}
```

The response's `skippedAlreadyPosted` is how many of the submitted items were already claimed (including a duplicate id sent twice in the same call). Appending more items to an open job (`POST /jobs/{{jobId}}/items`) works the same way. If every item in a non-open job is already posted, the call is refused with a `400 validation_failed` naming the count — nothing is created.

A job item whose id turns out to be already claimed by the time it runs (another submission won the race) finishes `status: "skipped"`, not `"failed"`: it does not count against your failure handling in section 4, and `GET /jobs/{{jobId}}/items/{{itemId}}` reports `skipped.reason` and the post it was already made as.

