# Contract: HTTP surfaces and security behaviour

This file covers what every response and every state-changing request must do. All of it is enforced in code, in one place per concern, and each piece has a test.

## 1. Same-origin guard (FR-021, research D16)

The guard lives in `src/lib/http/same-origin.ts`. It is pure, and `src/proxy.ts` calls it first, before the login redirect.

```ts
export function checkSameOrigin(input: {
  method: string; pathname: string; headers: Headers; appOrigin: string; // new URL(BETTER_AUTH_URL).origin
  sessionCookiePresent: boolean;
}): { ok: true } | { ok: false; reason: "origin_mismatch" | "cross_site_fetch" | "missing_origin" };
```

| Request | Outcome |
|---|---|
| `GET`, `HEAD`, `OPTIONS` | ok |
| path starts with `/api/v1/` or equals `/api/internal/tick` | ok (bearer-authenticated, cookies unused) |
| `Origin` present and equal to `appOrigin` | ok |
| `Origin` present and different (including `null`) | refuse `origin_mismatch` |
| `Origin` absent, `Sec-Fetch-Site` is `cross-site` or `same-site` | refuse `cross_site_fetch` |
| `Origin` absent, `Sec-Fetch-Site` absent or `same-origin`/`none`, and no session cookie | ok (non-browser client without a session) |
| `Origin` absent and a session cookie is present | refuse `missing_origin` |

**Refusal response:** `403`, `content-type: application/json`, body `{"error":"cross_origin"}`, with `cache-control: no-store`. The handler never runs, so the request has no side effect. The response does not distinguish the three reasons. Tests read the reason from the pure function.

**Surfaces covered, one test per surface type** (`tests/integration/security/csrf.test.ts`):

- a server action, posted to a page path with the `Next-Action` header. It is driven through `proxy()` with a `NextRequest`, and the test asserts that no row changed when the proxy refuses;
- `POST /p/<slug>/compose/check`;
- `POST /api/auth/sign-in/email` and `POST /api/auth/sign-out`. For these, Better Auth's own origin check (research F6) also applies, and the test runs with and without the proxy.

## 2. Security headers (FR-024, research D17)

**Static, from `next.config.ts` `headers()`, on `/:path*`:**

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin`. `/signup` keeps `no-referrer`: that rule is listed after this one, and the later rule wins. |

**Runtime, from `proxy()`.** The pure builder lives in `src/lib/http/security-headers.ts`:

```ts
export function buildCsp(input: {
  nonce: string; dev: boolean; publicMediaOrigin: string | null; oauthOrigins: readonly string[];
}): string;
export function securityHeaders(input: { appUrl: string; csp: string }): Record<string, string>;
```

- `Content-Security-Policy`, with directives in this order:
  - `default-src 'self'`
  - `script-src 'self' 'nonce-<n>' 'strict-dynamic'`, plus `'unsafe-eval'` when `dev`
  - `style-src 'self' 'unsafe-inline'`
  - `img-src 'self' data: blob: https:`, plus `<publicMediaOrigin>` when it is `http:`
  - `font-src 'self'`
  - `connect-src 'self'`
  - `object-src 'none'`
  - `base-uri 'self'`
  - `frame-ancestors 'none'`
  - `form-action 'self' <oauthOrigins…>`

  `oauthOrigins` is the origin of each registered connect group's `authorizationUrl({ state: "x", redirectUri: appUrl })`.
- **Nonce:** the nonce is also set on the **request** CSP header so Next applies it (F1). It is a fresh value per request: base64 of 16 random bytes.
- `Strict-Transport-Security: max-age=31536000` is sent only when `appUrl` starts with `https://`.

The root layout `await connection()` so every page renders dynamically and carries the nonce.

**Tests** (`tests/integration/security/headers.test.ts`):

- the builder's output for dev, prod, https and http;
- `proxy()` sets the runtime headers on a page path and on an `/api/v1/` path;
- the static rules in `next.config.ts` cover `/:path*` and keep the `/signup` override last;
- `/api/health` gets them too. It is matched by the proxy, and the static rules are asserted from the config object.

**Build smoke** (quickstart §6): with `pnpm build && pnpm start`, `curl -sI` on `/login` shows every header, and every `<script` tag in the HTML has `nonce="<the header's nonce>"`.

## 3. Tick endpoint (FR-022, research D18)

`POST /api/internal/tick` uses `handleTickRequest`.

| Case | Response |
|---|---|
| `TICK_SECRET` unset | `401 {"error":"unauthorized"}` + `WWW-Authenticate: Bearer`, no tick |
| no `Authorization`, or not `Bearer …` | same 401, no tick |
| wrong secret | same 401, no tick |
| correct secret but a non-empty query string (for example `?secret=…`) | same 401, no tick |
| correct secret, no query | `200` with the tick result, `Cache-Control: no-store`, exactly one `runTick()` |
| tick throws | `503 {"error":"tick_failed"}` |

- **Timing:** the comparison is always SHA-256 digests compared with `timingSafeEqual`. With no secret configured, it compares against a fixed digest so the timing matches. Every refusal has identical status, headers and body bytes.
- **Logging:** the presented value is never logged.
- **Tests:** `tests/integration/tick-endpoint.test.ts`, extended with one test per row. One test asserts the five refusal responses are byte-identical.

## 4. Request bodies (FR-025, research D19)

The reader lives in `src/server/http/body.ts`:

```ts
export class BodyTooLargeError extends Error {}
export async function readBodyWithin(request: Request, limit: number): Promise<Uint8Array>;
```

- A declared `Content-Length` over `limit` throws before anything is read.
- Otherwise the body is streamed through `request.body.getReader()`. As soon as the running total exceeds `limit`, it calls `reader.cancel()` and throws. A `null` body returns an empty array.
- **Users:**
  - the API pipeline (`readBytes` → 413 `payload_too_large`), with the limits unchanged: JSON 8 MB, multipart = upload limit + 1 MB;
  - `compose/check`, with a 256 KB limit, answering `413 {"ok":false,"error":"validation","message":"The request is too large."}`.
- Server actions keep Next's `serverActions.bodySizeLimit` (26 MB, needed for uploads). The findings record lists that as accepted.
- **Test:** a `ReadableStream` body with no length that yields 64 KB chunks forever. The reader must refuse after crossing the limit, having pulled at most `limit + one chunk`.

## 5. Outbound requests (FR-026, FR-023, research D20)

| Policy | Used by | Refused |
|---|---|---|
| `public` | media by URL | the existing list, plus 6to4 `2002::/16`, Teredo `2001::/32`, `2001:db8::/32`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, IPv4-compatible `::/96`, and any IPv4-mapped/-compatible form of a refused IPv4 address |
| `webhook` | webhook delivery and save-time check | everything `public` refuses **except** `10/8`, `172.16/12`, `192.168/16`, `100.64/10` and `fc00::/7` |
| `allow-loopback` | tests only, through `set*OverridesForTests` | as `public`, but loopback is allowed |

- **When the check runs:**
  - for an IP-literal URL, before connecting;
  - for a host name, inside the socket's `lookup`, on every connection, so a DNS answer that changes cannot bypass it (rebinding).
- **Redirects:** webhooks never follow them. Media by URL follows at most 3, each re-checked.
- **Tests:** `src/server/net/safe-fetch.test.ts` has an address table with one row per range and per policy. A local DNS stub `lookup` answers public first, then loopback, and the request must be refused on connect. Webhook save tests cover `localhost`, `127.0.0.1`, `[::1]`, `169.254.169.254`, `[::ffff:127.0.0.1]`, `[2002:7f00:1::]`, and a private `192.168.1.10` (allowed).

## 6. Secrets in outputs (FR-020, FR-023, research D23)

**Never present** in any captured output:

- account credentials, decrypted (tokens, app passwords, refresh tokens);
- `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `TICK_SECRET`;
- `S3_SECRET_ACCESS_KEY` and `S3_ACCESS_KEY_ID`;
- `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`;
- Meta and Threads app secrets;
- API key plaintexts after their creation response;
- webhook secrets after their creation or rotation response;
- invitation tokens outside the invite link shown to the inviter;
- session tokens outside `Set-Cookie`.

**Forms scanned:** raw, base64, base64url, `encodeURIComponent`, and hex for byte keys.

**Allowed appearances:**

- the creation or rotation response of an API key or webhook secret, to its creator;
- the invitation link in the inviter's creation result;
- the session token in its own `Set-Cookie` header.

Each allowed appearance is asserted in its own test and excluded by location, never by value.

**Captured outputs:**

- console;
- stdout and stderr;
- route responses (status, headers, body);
- server action results;
- rendered pages;
- `publish_attempts`;
- `membership_audit_log.details`;
- webhook receiver requests;
- error messages raised to the UI.

## 7. Session and sign-in (recorded in the findings, verified by test)

- **Cookies** (research F7):
  - `httpOnly`;
  - `SameSite=Lax`;
  - `Secure` with the `__Secure-` prefix when `BETTER_AUTH_URL` is https.

  The test signs in through the auth handler with an https base URL and parses `Set-Cookie`.
- **Sign-in limits:** a per-email limit of 3 per 10 s, plus a per-IP backstop of 30 per 10 s (existing `src/server/auth/auth.ts`). The findings record cites the existing tests.
- **Existence leaks:** a non-member gets the same `not_found` for a missing project, a foreign project, a foreign target id and a malformed id. This holds for pages, actions, `compose/check` and API (existing tests, plus new failures-view and action tests).
