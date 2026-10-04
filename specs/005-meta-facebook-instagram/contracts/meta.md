# Contract: shared Meta module (`src/providers/meta/`)

This module is not a provider and has no registry line. It imports nothing from `src/server/**`. It is reused by the Threads entry through `MetaApp`.

## `config.ts`

```ts
export const DEFAULT_GRAPH_VERSION = "v26.0";             // docs/research/meta.md
export const GRAPH_VERSION_PATTERN = /^v\d{1,3}\.\d{1,2}$/;

export interface MetaConfig { appId: string; appSecret: string; graphVersion: string; loginConfigId: string | null }

/** Pure. `null` = not configured (neither id nor secret). Issues carry names only. */
export function parseMetaEnv(source: Readonly<Record<string, string | undefined>>):
  { config: MetaConfig | null; issues: ProviderEnvIssue[] };

/** Reads process.env each call (no memo, so tests can stub env). Throws a value-free error when not configured. */
export function requireMetaConfig(): MetaConfig;
/** Graph version only. Used by advance, so publishing works as long as the version is valid. */
export function graphVersion(): string;
```

| Variable | Rule | Issue text |
|---|---|---|
| `META_APP_ID` | digits, 5–30; required when `META_APP_SECRET` is set | "required when META_APP_SECRET is set" / "must be the numeric app id" |
| `META_APP_SECRET` | `[0-9a-f]{32}` (case-insensitive) or 16–128 non-space; required when `META_APP_ID` is set | "required when META_APP_ID is set" / "must be the app secret from the dashboard" |
| `META_GRAPH_VERSION` | optional; `GRAPH_VERSION_PATTERN` | "must look like v26.0" |
| `META_LOGIN_CONFIG_ID` | optional; digits; ignored without id + secret, and then an issue: "set META_APP_ID and META_APP_SECRET to use it" | |

## `graph.ts`

```ts
export interface MetaApp {
  graphBase: string;          // "https://graph.facebook.com"
  version: string;            // "v26.0"
}

export type GraphOutcome =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "graph_error"; status: number; error: GraphError }
  | { kind: "http_error"; status: number }
  | { kind: "unparseable"; status: number }
  | { kind: "network"; phase: "before_send" | "after_send" };

export interface GraphError { code: number | null; subcode: number | null; type: string | null; message: string; traceId: string | null; transient: boolean }

/** One fetch. POST → form-urlencoded body (token included); GET → query. Never returns or logs the URL or body. */
export function graphRequest(app: MetaApp, req: {
  method: "GET" | "POST";
  path: string;                                  // "/{id}/feed", no version; ids validated as /^\d{1,40}(_\d{1,40})?$/
  params?: Record<string, string>;
  token?: string;                                // sent as access_token
  signal: AbortSignal;
}): Promise<GraphOutcome>;

/** Follows `paging.next` only on `app.graphBase`'s origin, max `pages`. */
export function graphList<T>(app: MetaApp, first: Parameters<typeof graphRequest>[1], pages: number):
  Promise<{ kind: "ok"; items: unknown[]; truncated: boolean } | Exclude<GraphOutcome, { kind: "ok" }>>;
```

- Reading the body: a JSON parse failure on 2xx is `unparseable`. On non-2xx it is `http_error`. A body stream error after the headers is `network/after_send`.
- `network/before_send` is decided only from `ECONNREFUSED`, `ENOTFOUND` or `EAI_AGAIN` in the cause chain (depth ≤ 5).

## `errors.ts`

```ts
export const GRAPH_ERROR_TABLE = {
  invalidToken: [190],               // docs/research/meta.md
  rateLimited: [4, 17, 32, 613],     // R3 interim, UNVERIFIED
  temporary: [1, 2],                 // R3 interim, UNVERIFIED (+ is_transient: true)
} as const;

export type GraphClass = "invalid_token" | "rate_limited" | "temporary" | "rejected";
export function classifyGraphError(e: GraphError): GraphClass;

/** US6 / research D12 table. Returns null for `ok`. */
export function graphStepError(outcome: GraphOutcome, opts: { mayPublish: boolean; platform: string; secrets: readonly string[] }):
  Extract<StepResult, { kind: "retryable_error" | "fatal_error" | "ambiguous" }> | null;

/** Secret-free summary fields for an outcome: httpStatus, graphCode, graphSubcode, graphType, traceId. */
export function graphSummary(outcome: GraphOutcome): Record<string, string | number>;

/** Replaces known secrets and access_token=/client_secret=/code=/fb_exchange_token= values; caps at 500 chars. */
export function scrub(text: string, secrets: readonly string[]): string;
```

Message format: `"<platform>: <scrubbed Graph message> (code <c>[/<sub>])"`. Messages for invalid tokens read `"<platform> says the access token is no longer valid (code 190/<sub>)."`.

## `oauth.ts`

```ts
export const META_DIALOG_BASE = "https://www.facebook.com";   // R7 interim
export const META_SCOPES = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "instagram_basic", "instagram_content_publish"] as const;

export function dialogUrl(cfg: MetaConfig, input: { state: string; redirectUri: string }): string;
// https://www.facebook.com/{v}/dialog/oauth?client_id&redirect_uri&state&response_type=code&(config_id | scope=a,b,c)

export function exchangeCode(app: MetaApp, cfg: MetaConfig, input: { code: string; redirectUri: string; signal: AbortSignal }):
  Promise<{ ok: true; userToken: string } | { ok: false; message: string }>;      // GET /oauth/access_token (R7)

export function exchangeLongLived(app: MetaApp, cfg: MetaConfig, input: { token: string; signal: AbortSignal }):
  Promise<{ ok: true; userToken: string } | { ok: false; message: string }>;      // grant_type=fb_exchange_token [research]
```

The messages never contain the token, code or secret. Failures map to "Could not finish signing in with Facebook (<reason>). Check the Meta app id, secret and redirect address in docs/meta-setup.md." A Graph 190 on the paste path maps to "That token is expired or invalid. Generate a new one in Graph API Explorer."

## `candidates.ts`

```ts
export function listPageCandidates(app: MetaApp, input: { userToken: string; signal: AbortSignal }): Promise<CandidatesResult>;
```

This implements [research D16](../research.md) (`/me/accounts` fields, R8 names, R9 paging, notes). On `truncated` it adds a notice: "Only the first 500 Pages are shown."

## `connect-group.ts`

```ts
export const metaConnectGroup: OAuthConnectGroup = {
  key: "meta",
  displayName: "Facebook Pages and Instagram",
  setupDoc: "docs/meta-setup.md",
  environment: { variables: [META_APP_ID, META_APP_SECRET(secret), META_GRAPH_VERSION, META_LOGIN_CONFIG_ID], issues, configured },
  authorizationUrl: ({ state, redirectUri }) => dialogUrl(requireMetaConfig(), { state, redirectUri }),
  exchangeCode: code → exchangeCode → exchangeLongLived → listPageCandidates,
  describeCallbackError: error=access_denied → cancelled; else platform_error,
  pasteToken: { field: { name: "userToken", label: "User access token", secret: true }, help, exchange: exchangeLongLived → listPageCandidates },
};
```

The short-lived and long-lived user tokens exist only as local variables inside `exchangeCode` / `pasteToken.exchange`.

## `credentials.ts`

```ts
export const pageTokenCredentials: z.ZodType<{ pageToken: string }>;
export function readPageToken(credentials: unknown): string | null;
```
