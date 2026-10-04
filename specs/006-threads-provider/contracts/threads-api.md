# Contract: Threads HTTP calls Docket makes

The outbound contract. Every call is one `fetch` through the shared `graphRequest` (`src/providers/meta/graph.ts`). Each honours the caller's `AbortSignal`, never exposes the URL or body, and returns a typed `GraphOutcome`.

- `{base}` = `THREADS_GRAPH_BASE` (default `https://graph.threads.com`, U1).
- `{v}` = `THREADS_API_VERSION` = `v1.0` (R1 interim).
- Interim items are marked **(Rn)**. All are covered by mocked tests only.

## Authorization (browser redirect, built by `authorizationUrl`)

```text
GET https://threads.com/oauth/authorize
    ?client_id=<THREADS_APP_ID>
    &redirect_uri=<BETTER_AUTH_URL>/connect/callback     (HTTPS, not localhost: G10)
    &scope=threads_basic,threads_content_publish
    &response_type=code
    &state=<single-use state>
```

The callback receives `code` and `state`, or `error` / `error_reason` / `error_description`.

## Token calls (unversioned, R1/R3)

| Purpose | Request | Secrets travel in | Success read |
|---|---|---|---|
| Code → short-lived | `POST {base}/oauth/access_token`, form: `client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri`, `code` | body | `access_token` (string). `permissions`/`scope` read for notes only |
| Short-lived → long-lived | `GET {base}/access_token?grant_type=th_exchange_token&client_secret=…&access_token=…` | query (research shows GET; D10) | `access_token`, `expires_in` (else 60 d) |
| Renew long-lived | `GET {base}/refresh_access_token?grant_type=th_refresh_token&access_token=…` | query (D10) | `access_token`, `expires_in` (else 60 d) |

## Profile (R2)

`GET {base}/{v}/me?fields=id,username` with the token → `{ id: string /^\d{1,40}$/, username?: string }`. A missing or malformed `id` is a failure.

## Publishing (FR-024–FR-029)

| Step | Request | Params |
|---|---|---|
| `create_container` (TEXT) | `POST {base}/{v}/{user-id}/threads` | `media_type=TEXT`, `text` |
| `create_container` (IMAGE) | `POST {base}/{v}/{user-id}/threads` | `media_type=IMAGE`, `image_url=<variant public URL>`, `text` if not empty, `alt_text` if not blank |
| `create_item_k` | `POST {base}/{v}/{user-id}/threads` | `media_type=IMAGE`, `image_url`, `is_carousel_item=true`, `alt_text` if not blank **(R5)** |
| `create_carousel` | `POST {base}/{v}/{user-id}/threads` | `media_type=CAROUSEL`, `children=<id1,id2,…>` in image order, `text` if not empty **(R5)** |
| `check_status` | `GET {base}/{v}/{container-id}?fields=status,error_message` | — |
| `check_quota` | `GET {base}/{v}/{user-id}/threads_publishing_limit?fields=quota_usage,config` | — **(R7)** |
| `publish` | `POST {base}/{v}/{user-id}/threads_publish` | `creation_id=<container>` |

- Every request carries `access_token` (in the form body for POST, the query for GET).
- `auto_publish_text` is **never** sent.
- A create reply is read as `{ id }`, a status reply as `{ status: "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED", error_message?: string }`, and a publish reply as `{ id }`.
- Quota is read as `data[0].quota_usage: number` and `data[0].config.quota_total: number > 0`; anything else = unknown.

## Outcome classification (shared `graphStepError`, R4)

| Outcome | Non-publishing step | `publish` step |
|---|---|---|
| `network` before send (ECONNREFUSED, ENOTFOUND, EAI_AGAIN) | `retryable_error` | `retryable_error` |
| `network` after send (timeout/abort, reset, body read failure) | `retryable_error` | `ambiguous` |
| 2xx unparseable | `retryable_error` | `ambiguous` |
| 2xx without the needed id/status | `retryable_error` | `ambiguous` (no id) |
| HTTP 5xx or 429 without a Graph body | `retryable_error` | `ambiguous` |
| Other HTTP 4xx without a Graph body | `fatal_error` | `fatal_error` |
| Graph code 190 | `fatal_error` + `credentialsInvalid` | `fatal_error` + `credentialsInvalid` |
| Graph code 4/17/32/613 | `retryable_error` | `retryable_error` |
| Graph code 1/2 or `is_transient` | `retryable_error` | `ambiguous` |
| Graph 5xx with body | `retryable_error` | `ambiguous` |
| Other Graph error | `fatal_error` (scrubbed message; create steps add the public-URL hint when the message mentions fetching or the URL) | `fatal_error` + " Retry the post to create it again." |

For token calls, the connect, paste and refresh code reads the same outcomes:

- `ok` with a token → success;
- network, 5xx, 429, temporary or rate limit → **transient** (refresh keeps the old token; connect and paste say "try again" and change nothing);
- 190, other Graph errors and other 4xx → **definitive** (refresh → `needs_reauth`; paste → the next option in D6; connect → failure message).

## Secrets

- Never in Docket-built URLs for the browser, logs, `publish_attempts`, step state, `last_error`, thrown messages or snapshots.
- Platform messages pass through `scrub(message, [token, appSecret, code])`, which removes `access_token=`, `client_secret=`, `code=`, `fb_exchange_token=` and `refresh_token=` values and every known secret string, then caps the text at 500 characters.
