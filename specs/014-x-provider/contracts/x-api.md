# Contract: X HTTP shapes used by the mocks

Every request and response shape here comes from `docs/research/x.md`. **UNVERIFIED** shapes are marked, and their tests cover both a documented-looking body and an empty or non-JSON one (FR-040). The fake lives in `tests/helpers/fake-x.ts`. It stubs `fetch` with `vi.stubGlobal`, so no request leaves the process.

## Fake X (`tests/helpers/fake-x.ts`)

Modelled on `tests/helpers/fake-graph.ts`.

- `on(method, path, script)` scripts a reply. The path has no query, except STATUS, which is keyed `GET /2/media/upload?command=STATUS`. A list of replies is consumed in order and its last entry repeats.
- Reply kinds:
  - `ok {status?, body, headers?}`
  - `problem {status, title?, detail?, headers?}` (a Problem JSON body)
  - `oauth_error {status, error, error_description?}`
  - `http {status, body?, headers?}` (raw text)
  - `unparseable` (a 2xx with a non-JSON body)
  - `hang` (settles only on abort)
  - `reset_mid_body`
  - `pre_send_failure` (rejects with a cause code of `ECONNREFUSED`)
- `requests[]` logs, per request: method, host, path, query and form/JSON fields. Each field is redacted when it equals a known secret. The log also records `auth: "basic" | "bearer" | "none"`, `basicUser` (the client id decoded from Basic auth, never the secret), and `multipart: { fields: string[], mediaBytes: number, mediaType }`.
- Helpers:
  - `rateLimited({ remaining, reset })` returns the `x-rate-limit-*` headers;
  - `tokenReply(overrides)` returns `{ token_type: "bearer", expires_in: 7200, access_token, refresh_token, scope }`.

## Token endpoint: `POST https://api.x.com/2/oauth2/token`

Request: `Content-Type: application/x-www-form-urlencoded`, `Authorization: Basic base64(id:secret)`.

| Grant | Body |
|---|---|
| exchange | `grant_type=authorization_code&code=…&redirect_uri=…&code_verifier=…` |
| refresh | `grant_type=refresh_token&refresh_token=…` |

Success (200):

```json
{ "token_type": "bearer", "expires_in": 7200, "access_token": "…", "refresh_token": "…", "scope": "tweet.read tweet.write users.read media.write offline.access" }
```

Refusal: **UNVERIFIED** (U3), and the tests cover both shapes:

- `400 {"error":"invalid_grant","error_description":"…"}` (RFC 6749 shape);
- `400` with an empty body.

## `GET https://api.x.com/2/users/me`

Request: `Authorization: Bearer …`. Success (200): `{"data":{"id":"2244994945","name":"Docket Test","username":"dockettest"}}`.

## Media (v2 chunked)

| Call | Request | Success body |
|---|---|---|
| `POST /2/media/upload/initialize` | JSON `{"media_type":"image/jpeg","total_bytes":12345,"media_category":"tweet_image"}` | `{"data":{"id":"1880028106020515840","media_key":"3_1880028106020515840","expires_after_secs":86400}}` |
| `POST /2/media/upload/{id}/append` | multipart: `media` (bytes), `segment_index=0` | `{"data":{"expires_at":1760000000}}` (any 2xx accepted) |
| `POST /2/media/upload/{id}/finalize` | no body | `{"data":{"id":"…","media_key":"…","size":12345,"expires_after_secs":86400}}`, optionally with `"processing_info":{"state":"pending","check_after_secs":1}` |
| `GET /2/media/upload?command=STATUS&media_id={id}` | — | `{"data":{"id":"…","processing_info":{"state":"in_progress","check_after_secs":2,"progress_percent":40}}}` → later `"state":"succeeded"` or `"failed"` |
| `POST /2/media/metadata` | JSON `{"id":"…","metadata":{"alt_text":{"text":"…"}}}` | `{"data":{"id":"…","associated_metadata":{}}}` |

- The `86400` and the media ids above are example values for mocks, not facts Docket relies on.
- Code reads `expires_after_secs` and falls back to 3,600 s when it cannot (research D10).
- Calls that must **never** be made: `POST /2/media/upload` (one-shot, U1), and any request carrying `command=INIT|APPEND|FINALIZE`. The tests assert this from `requests[]`.

## Create post: `POST https://api.x.com/2/tweets`

Request: Bearer token, JSON `{"text":"…"}` or `{"text":"…","media":{"media_ids":["…","…"]}}`.

Success (201): `{"data":{"id":"1445880548472328192","text":"…","edit_history_post_ids":["1445880548472328192"]}}`.

Errors (Problem objects):

- `403 {"type":"about:blank","title":"Forbidden","status":403,"detail":"You are not allowed to create a Tweet with duplicate content."}`. The duplicate detail is **UNVERIFIED** (U2). It is also tested with an empty body and with another detail.
- `401`: body **UNVERIFIED**. Tested with a Problem body and with an empty body.
- `429` with `x-rate-limit-limit`, `x-rate-limit-remaining`, `x-rate-limit-reset` (Unix seconds): body **UNVERIFIED**. Tested with:
  - remaining `0` and a reset;
  - remaining `5` (the usage-cap path);
  - no headers.
- `500/502/503/504`.

## Rate-limit headers

`x-rate-limit-reset` is parsed as a positive integer of Unix **seconds**, multiplied by 1000. Anything else is unreadable. `x-rate-limit-remaining` is parsed as a non-negative integer.
