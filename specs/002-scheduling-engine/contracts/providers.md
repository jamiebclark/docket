# Contract: Provider framework (developer-facing)

Location: `src/providers/`. Providers are **pure plug-ins**:

- they never import the database client, the DAL, services or `next/*`;
- they receive everything through arguments;
- they return results.

The engine (`src/server/scheduler/`) owns persistence, leases, retries,
limits, decryption and redaction. Adding a provider = add
`src/providers/<key>/` + one line in `src/providers/registry.ts` (FR-012,
constitution V).

```text
src/providers/
├── types.ts          # every type below
├── registry.ts       # the provider list + lookup
├── text.ts           # countGraphemes / countCodePoints / countUtf8Bytes / countText
├── validation.ts     # validateAgainstCapabilities, inferPostType
├── errors.ts         # UnknownProviderError
└── mock/
    ├── index.ts      # export const mockProvider: SocialProvider
    ├── settings.ts   # Zod settings schema (behaviour)
    └── mock.test.ts
```

## Types (`src/providers/types.ts`)

```ts
export type PostType = "text" | "image" | "carousel" | "video" | "story" | "reel"; // only the first three are used now
export type TextCountingRule = "graphemes" | "code_points" | "utf8_bytes";

export interface ProviderCapabilities {
  text: { maxLength: number; countingRule: TextCountingRule };
  media: {
    maxImages: number;                 // 0 = no images
    allowedMimeTypes: readonly string[];
    maxBytesPerFile: number;
    required: boolean;                 // e.g. Instagram: true
  };
  textOnlyAllowed: boolean;            // e.g. Instagram: false
  postTypes: readonly PostType[];
}

export interface PublishLimit { count: number; windowSeconds: number }

export type ConnectStrategy =
  | { strategy: "oauth" }                                   // flow built by the provider's entry
  | { strategy: "credentials"; fields: readonly CredentialField[] }  // e.g. Bluesky handle + app password
  | { strategy: "manual-token"; fields: readonly CredentialField[] };
export interface CredentialField { name: string; label: string; secret: boolean; help?: string }

export interface MediaItem {
  url: string; mimeType: string; width: number | null; height: number | null;
  bytes: number; altText: string;
}
export interface PostContent { text: string; media: readonly MediaItem[] }

export interface ValidationIssue {
  severity: "error" | "warning";
  code:
    | "text_too_long" | "too_many_images" | "mime_not_allowed" | "file_too_large"
    | "media_required" | "text_only_not_allowed" | "unsupported_post_type"
    | "missing_alt_text" | "empty_post" | (string & {});    // providers may add codes
  message: string;           // human, e.g. "Text is 312 graphemes; the limit is 300."
  field: "text" | "media" | `media.${number}` | "postType";
  count?: number; limit?: number;
}

export interface StepInfo { name: string; mayPublish: boolean }

export interface PublishContext {
  target: { id: string; scheduledAt: Date; attempt: number };   // attempt = attempt_count + 1
  account: {
    id: string; externalId: string; displayName: string;
    settings: unknown;          // already parsed by provider.settingsSchema
    credentials: unknown | null; // decrypted object, or null when none stored
  };
  content: PostContent;
  postType: PostType;
  state: unknown | null;        // null on the first step
  now: Date;                    // the engine clock (DB time)
  signal: AbortSignal;          // aborted at the provider-call timeout; pass it to fetch
}

export interface AttemptSummary { request?: Record<string, unknown>; response?: Record<string, unknown> }

export type StepResult = (
  | { kind: "continue"; state: unknown; notBefore?: Date }
  | { kind: "done"; externalId: string; url?: string }
  | { kind: "retryable_error"; error: string; notBefore?: Date }  // brief: notBefore required; optional here, engine backoff applies when absent
  | { kind: "fatal_error"; error: string }
  | { kind: "ambiguous"; error: string }
) & { summary?: AttemptSummary };

export type RefreshResult =
  | { ok: true; credentials: unknown; expiresAt: Date | null }
  | { ok: false; reason: string };

export interface SocialProvider<Settings = unknown, State = unknown> {
  key: string;                          // lowercase [a-z0-9-]+, unique, stored in social_accounts.provider_key
  displayName: string;
  capabilities: ProviderCapabilities;
  defaultPublishLimit?: PublishLimit;   // e.g. Instagram { count: 100, windowSeconds: 86400 }
  connect: ConnectStrategy;
  settingsSchema: z.ZodType<Settings>;  // non-secret per-account settings; z.object({}) if none
  refreshCredentials?(input: {
    account: { id: string; externalId: string; settings: Settings };
    credentials: unknown; now: Date; signal: AbortSignal;
  }): Promise<RefreshResult>;
  validate(content: PostContent, capabilities: ProviderCapabilities): ValidationIssue[];
  stepFor(state: State | null, settings: Settings): StepInfo;   // settings = parsed account settings (decisions.md, 002)
  advance(ctx: PublishContext): Promise<StepResult>;
}
```

### The meaning of each step result, and what the engine does

| Result | Use when | Engine action |
|---|---|---|
| `continue` | the step succeeded and another step is needed (container created, still processing) | persist `state`, `attempt_count = 0`, release the lease, `next_attempt_at = max(now, notBefore)`. The target stays `publishing`. The next step runs in a **later** tick |
| `done` | the post is live and you have its id | `published`, store `external_id` / `url` / `published_at` |
| `retryable_error` | you are **sure nothing was published** (connection refused, 5xx/429 before the create call, a timeout on a read-only or container step) | backoff (D9), `attempt_count + 1`; `failed` at the cap |
| `fatal_error` | the platform definitively rejected it (validation, permission revoked, 4xx on create) | `failed` at once |
| `ambiguous` | the call **that could make the post public** was sent and you can't tell whether it took effect (timeout or abort after sending, unparseable 2xx, connection reset mid-response) | `ambiguous`. Never retried automatically; a human resolves it |

Rules:

- `stepFor(state)` must be **pure and total**. `mayPublish: true` marks a step whose request can make the post public.
- If the engine loses track of a step (killed tick, provider throws, engine timeout), `mayPublish` decides the outcome: true → `ambiguous`, false → retry.
- A provider must never return `retryable_error` from a `mayPublish` step unless it knows the request was not sent.
- `advance` does **one** bounded unit of work. No polling loops and no sleeps; return `continue` with `notBefore` instead.
- Honour `ctx.signal` on every network call.
- **No secrets anywhere** except the HTTP request itself:
  - never in `error`, `summary`, `state`, thrown messages or logs;
  - `state` is stored as plain jsonb, so it must not contain tokens.

  The engine also redacts (research D16), but that is a backstop, not a licence.
- Tests use mocked HTTP only, and never make live calls (constitution II). Cover `validate` and every `advance` result, including the ambiguous paths.

## Registry (`src/providers/registry.ts`)

```ts
import { mockProvider } from "./mock";
export const providers = [mockProvider /* , blueskyProvider */] as const satisfies readonly SocialProvider[];

export function getProvider(key: string): SocialProvider;            // throws UnknownProviderError(key)
export function findProvider(key: string): SocialProvider | undefined;
export function listProviders(): readonly SocialProvider[];
```

- Keys must be unique. A unit test asserts uniqueness and the key format.
- The engine uses `findProvider`. A stored account whose provider is missing fails its due targets with "The <key> provider is no longer available" (`account_unavailable`) and never crashes the tick (US7-AS1).
- Which providers can be connected is decided in `services/accounts.ts` (`listConnectableProviders`): the mock is hidden unless `MOCK_PROVIDER_ENABLED` (D21).

## Text counting (`src/providers/text.ts`), FR-013

```ts
export function countGraphemes(text: string): number;   // Intl.Segmenter(undefined, { granularity: "grapheme" })
export function countCodePoints(text: string): number;  // [...text].length
export function countUtf8Bytes(text: string): number;   // Buffer.byteLength(text, "utf8")
export function countText(text: string, rule: TextCountingRule): number;
```

Required unit cases: ASCII; `"👨‍👩‍👧‍👦"` (1 grapheme, 7 code points, 25 bytes);
`"é"` (1 grapheme, 2 code points, 3 bytes); CJK; flag emoji; empty
string.

## Shared validation (`src/providers/validation.ts`), FR-027

```ts
export function inferPostType(content: PostContent): "text" | "image" | "carousel"; // 0 / 1 / >1 media
export function validateAgainstCapabilities(content: PostContent, caps: ProviderCapabilities): ValidationIssue[];
```

These are emitted in a stable order, `text` first, then `postType`, then `media`.

**Errors**:

- `empty_post`: no text and no media.
- `text_too_long`: carries `count` and `limit`, counted by `caps.text.countingRule`.
- `text_only_not_allowed`.
- `media_required`.
- `too_many_images`: carries `count` and `limit`.
- `mime_not_allowed`: `field: media.N`.
- `file_too_large`: `field: media.N`, carries `count = bytes` and `limit`.
- `unsupported_post_type`.

**Warning**:

- `missing_alt_text` (`media.N`).

## Mock provider (`src/providers/mock/`), FR-015

- `key: "mock"`, `displayName: "Mock (offline)"`.
- Connect: `{ strategy: "credentials", fields: [] }`. The account is created by `accounts.connectMock` (contracts/services.md), not by a form.
- Capabilities: `text { maxLength: 500, countingRule: "graphemes" }`; `media { maxImages: 4, allowedMimeTypes: ["image/jpeg","image/png"], maxBytesPerFile: 5_000_000, required: false }`; `textOnlyAllowed: true`; `postTypes: ["text","image","carousel"]`.
- `defaultPublishLimit`: none. Tests set account limits.
- `settingsSchema`:

  ```ts
  z.object({
    behaviour: z.enum(["succeed","multi_step","retryable","fatal","ambiguous","rate_limited","throw"]).default("succeed"),
    steps: z.number().int().min(1).max(10).default(1),            // multi_step: continues before the publish step
    failTimes: z.number().int().min(1).max(100).optional(),       // retryable: fail the first N attempts, then succeed; omitted = always
    retryAfterSeconds: z.number().int().min(1).max(86400).default(300), // rate_limited notBefore
    delayMs: z.number().int().min(0).max(60000).default(0),       // slow provider (respects ctx.signal)
    refresh: z.enum(["succeed","fail"]).default("succeed"),
  })
  ```

- Steps:
  - `stepFor(null)` → `{ name: behaviour === "multi_step" ? "create_container" : "publish", mayPublish: behaviour !== "multi_step" }`.
  - With state `{ done: n }`: `n < steps` → `create_container` (mayPublish false), else `publish` (mayPublish true).
- `advance` by behaviour:

  | Behaviour | Result |
  |---|---|
  | `succeed` | `done { externalId: "mock-<uuid>", url: "https://mock.invalid/<externalId>" }` |
  | `multi_step` | `continue { state: { done: n+1 } }` until `steps` continues, then `done` |
  | `retryable` | `retryable_error`, while `failTimes` is omitted or `ctx.target.attempt ≤ failTimes`; then `done` |
  | `fatal` | `fatal_error` |
  | `ambiguous` | `ambiguous` |
  | `rate_limited` | `retryable_error { notBefore: now + retryAfterSeconds }` |
  | `throw` | throws `Error("mock provider threw")` |

  Each result carries `summary: { request: { step, attempt, textLength }, response: { behaviour } }`.
- `refreshCredentials`: `refresh === "succeed"` → `{ ok: true, credentials: { token: "mock-" + randomUUID() }, expiresAt: now + 60 days }`; otherwise `{ ok: false, reason: "Mock refresh failure" }`.

## Guide (`docs/adding-a-provider.md`), FR-014 / SC-011

Required sections:

1. Checklist (folder, registry line, tests, docs).
2. The `SocialProvider` contract, field by field.
3. Capabilities and counting rules.
4. Connect strategies and where credentials live (encrypted, engine-decrypted).
5. Settings vs credentials.
6. `stepFor`, `mayPublish` and state persistence between steps.
7. Each `StepResult`, with a decision table for **when to return `ambiguous`**.
8. Publish limits (`defaultPublishLimit`; the engine enforces them).
9. `refreshCredentials` and `needs_reauth`.
10. Testing with mocked HTTP only.
11. The no-secrets rule.
12. Worked example: the `mock` provider.
