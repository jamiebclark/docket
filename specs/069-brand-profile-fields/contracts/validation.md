# Contract: validation

**Feature**: `specs/069-brand-profile-fields` | **Date**: 2026-10-13

The one place each brand rule is expressed, and the exact strings a person sees.

## 1. `src/lib/validation/link.ts` — new, shared with voice profiles

The http/https rule, extracted from `src/lib/validation/voice.ts` and used by both (B5, FR-006, P5).

```ts
export const LINK_URL_MAX = 500;
export const LINK_URL_LENGTH_MESSAGE = "Keep links to 500 characters or fewer";
export const HTTP_LINK_MESSAGE = "Enter a full http or https link";

/** True only for an absolute http(s) URL the WHATWG parser accepts. */
export function isHttpUrl(value: string): boolean;

/** Trimmed, length-capped, then scheme-checked — in that order. */
export const linkUrlSchema: z.ZodType<string>;
```

- `isHttpUrl` is the body that is in `voice.ts` today, moved verbatim: `new URL(v).protocol` is `"http:"`
  or `"https:"`, any throw is `false`.
- `linkUrlSchema` is `z.string().trim().max(LINK_URL_MAX, { error: LINK_URL_LENGTH_MESSAGE }).refine(isHttpUrl, { error: HTTP_LINK_MESSAGE })`
  — the same checks in the same order, so the length message wins for a 600-character non-URL exactly as
  it does today.
- `voice.ts`'s `preferredLinks` becomes `z.object({ url: linkUrlSchema, label: text(80).default("") })`.
  **`src/lib/validation/voice.test.ts` must pass unchanged** (FR-031); a changed expectation there means
  the extraction changed behaviour and is a defect.
- Re-exported from `src/lib/validation/index.ts`. The module imports only `zod` — no provider registry,
  no server import — so it is safe for a client component to reach.

### Accepted / refused

| Input | Verdict | Message |
|---|---|---|
| `https://example.test/a?b=c#d` | accepted, stored as typed | — |
| `HTTPS://example.test/x` | **accepted** — the WHATWG parser lower-cases the scheme (inherited behaviour, verified) | — |
| `  https://example.test  ` | accepted, stored trimmed | — |
| 500 characters of valid `https://…` | accepted | — |
| 501 characters | refused | `Keep links to 500 characters or fewer` |
| `example.com` | refused | `Enter a full http or https link` |
| `//example.test` | refused (`ERR_INVALID_URL`) | `Enter a full http or https link` |
| `/about` | refused | `Enter a full http or https link` |
| `javascript:alert(1)`, `data:…`, `file:///x`, `ftp://x.test` | refused | `Enter a full http or https link` |
| `https://example.test` that 404s or never resolves | **accepted** — nothing fetches it (FR, spec edge case) | — |

No host lower-casing, no scheme coercion, no trailing-slash or `www` normalisation (B6, FR-011).

## 2. `src/lib/validation/brand.ts` — new

```ts
export const TAGLINE_MAX = 200;
export const BRAND_DESCRIPTION_MAX = 1000;

/** CR/LF runs (with surrounding spaces) collapse to one space; trimmed; empty -> null. */
export function normaliseBrandLine(value: string): string | null;
/** CRLF -> LF, trimmed, empty -> null; interior blank lines survive. */
export function normaliseBrandText(value: string): string | null;

export const taglineSchema: z.ZodType<string | null>;          // <= 200 after normalising
export const brandDescriptionSchema: z.ZodType<string | null>; // <= 1000 after normalising
export const brandWebsiteSchema: z.ZodType<string | null>;     // null, or linkUrlSchema
```

Shape of each field schema: normalise first, then apply the limit, so a value is never refused for
whitespace a person cannot see and `null` short-circuits the URL rule (P8, P9).

| Field | Limit | Over-limit message |
|---|---|---|
| `tagline` | 200 characters after normalising | `Keep this to 200 characters or fewer` |
| `description` | 1000 characters after normalising | `Keep this to 1000 characters or fewer` |
| `websiteUrl` | `link.ts` | see §1 |

### Normalisation table

| Submitted | Stored |
|---|---|
| `""`, `"   "`, `"\r\n \n"` | `null` (any of the three fields) |
| tagline `"Ships your posts.\r\n  On time."` | `"Ships your posts. On time."` (one line, single space) |
| tagline `"A\n\n\nB"` | `"A B"` |
| description `"Para one.\r\n\r\nPara two.  "` | `"Para one.\n\nPara two."` (blank line kept) |
| website `"  https://x.test "` | `"https://x.test"` |
| tagline of 210 characters that normalises to 198 | accepted at 198 |
| tagline of 205 characters with no whitespace to collapse | refused |

Exactly 200 / 1000 / 500 are accepted; 201 / 1001 / 501 are each refused with that field's message
(spec edge case).

## 3. `updateSettingsSchema` — the patch semantics

`src/server/services/projects.ts`:

```ts
export const updateSettingsSchema = createProjectSchema.extend({
  defaultApprovalPolicy: approvalPolicySchema,
  defaultSchedulingPolicy: schedulingPolicySchema,
  confirmUnreviewedQueue: z.boolean().default(false),
  tagline: taglineSchema.optional(),
  description: brandDescriptionSchema.optional(),
  websiteUrl: brandWebsiteSchema.optional(),
});
```

| Submission | Effect (B4, FR-008) |
|---|---|
| key absent | the stored value is left alone; the key is omitted from the patch |
| key present, non-empty, valid | stored (normalised) |
| key present, empty or whitespace-only | cleared to `null` |
| key present, invalid | `ZodError` on that field's path; **nothing** is written for any field, and no audit row (FR-010) |

`createProjectSchema` is **not** extended (P11): project creation takes no brand value.

Field error paths are `tagline`, `description`, `websiteUrl`, so the existing `fieldErrorsFromZod` in
`src/lib/action-result.ts` maps them onto the form's inputs with no new plumbing.

Parsing happens before `scope.transaction` is entered, which is why a refused value cannot write
anything (P10).
