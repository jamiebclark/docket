# Contract: the one API operation

**Feature**: 083 | Satisfies FR-060 to FR-064, US7, SC-008

## §1 The operation

New file `src/server/api/operations/insights.ts`, one operation, registered once in `OPERATIONS`
(`src/server/api/operations/index.ts`) **after `activityOperations`**.

```ts
defineOperation({
  id: "getInsights",
  method: "GET",
  path: "/insights",
  permission: "read",
  tag: "Insights",
  summary: "Account trends and performance comparisons",
  query: ApiInsightsQuerySchema,
  responses: { 200: …, 400: …, 401: …, 403: … },
  idempotent: false,
  mcp: { expose: true },
  async run(scope, { query }) {
    return { status: 200, body: await getInsightsForApi(scope, query) };
  },
})
```

One registry line yields the REST route, the OpenAPI document and the MCP tool together (SC-008).
`run` calls exactly one service function, which is the same one the Insights page calls — the screen
and the API cannot disagree because there is one implementation (constitution IV).

### The `mcp.expose` decision, recorded

`{ expose: true }`, no `confirm`. It is a read-only, bounded, project-scoped view of numbers an agent
asking "how did last week do?" needs; `McpConfirm` guards effects and this operation has none; and
US7 asks for MCP access by name. Tool name `docket_get_insights`, placed after `docket_list_activity`
because `PUBLISHED_TOOL_NAMES` is maintained in operation-table order.

## §2 Query

```ts
ApiInsightsQuerySchema = {
  from?: string;          // calendar day in the project time zone, inclusive; default to - 29 days
  to?: string;            // calendar day, inclusive; default today
  accountId?: string;     // restrict to one account
  dimension?: "slot" | "day_of_week" | "series_kind" | "voice_profile" | "origin";
  metricKey?: string;     // must be declared by the platform of the account(s) in scope
}
```

Unknown parameters are rejected, `from` after `to` is a 400 with a field-level detail, and a
`metricKey` not declared by the platform in scope is a 400 — the same shape `listActivity` already
uses. There is no parameter combination that can ask for two platforms' metrics in one figure
(FR-034): `metricKey` is resolved against one platform at a time.

## §3 Response

```ts
{
  range: { from: string; to: string; timeZone: string },
  trends: [{
    accountId, accountName, platform, providerKey,
    metricKey, label,
    shape: { kind: "cumulative" } | { kind: "windowed", windowMs } | …,
    points: [{ day, value, capturedAt }],      // gaps are absent days, never zeros
    asOf: string | null,
    lastSuccessfulReadAt: string | null
  }],
  trendNotes: [{ providerKey, platform, reason, docsPath }],   // "reports no account numbers"; `unknown` shapes
  comparisons: [{
    dimension, platform, providerKey, metricKey, label, shape,
    conclusion: "ranked" | "not_enough_posts",
    groups: [{ key, label, removed, sampleSize, mean, median, verdict, singleAccount }],
    suppressedGroupCount: number,
    exclusions: [{ reason, count }],
    asOf: string | null
  }],
  firstEngagement: { … same groups, with figures shaped as in first-engagement.md §4 }
}
```

### The refusal is in the schema, not in the prose

FR-063 forbids returning a ranking the screen would decline to draw. So:

- `sampleSize` is present on **every** group, always (FR-031);
- `verdict` is `"ranked"` or `"provisional"` — a `suppressed` group never appears, and
  `suppressedGroupCount` says how many were withheld;
- `conclusion` is the machine-readable "not enough posts" marker (FR-063). When it is
  `"not_enough_posts"`, `groups` is returned in **label order**, so a client that sorts by position
  learns nothing it should not;
- no field anywhere carries a rank, a position, a "best" flag or a score.

A client cannot accidentally present an unranked comparison as a ranking without ignoring a field
that is always present.

### Nothing about the platform connection appears

No credential, token, secret, raw provider payload, external id, account access detail, scope list or
provider error string (FR-064). `accountName` and `platform` are already visible to any member of the
project through the accounts page. The first-engagement figures carry **no** commenter name, handle,
identifier, URL or text — the stored row holds none (see
[first-engagement.md](./first-engagement.md) §2).

## §4 Authorization

`permission: "read"`, enforced by the registry's standard path: a key without `read` gets the
registry's `missing_permission` error (US7.3). Every read goes through the scoped data-access layer,
so a key for project A asking for project B gets nothing by the same mechanism every other operation
uses (US7.2) — asserted by `tests/integration/api/scope-enforcement.test.ts` once the fixture is
added.

On the screen side, the Insights page requires `scope.can({ post: ["view"] })` — "any member who can
read the project's posts", the spec's assumption. No new role, no new permission, and the inbox's
stricter owner/admin/editor rule does **not** apply, because this surfaces a derived interval and
never inbox content.

## §5 The five places that enumerate the surface

Each is guarded by its own test and all five fail with near-identical messages, so they change in one
commit:

1. `src/server/mcp/naming.ts` — `PUBLISHED_TOOL_NAMES`, add `"docket_get_insights"` after
   `"docket_list_activity"`.
2. `tests/unit/mcp/naming.test.ts` — the same list literally; the test name `"is the frozen twenty"`
   becomes `"is the frozen twenty-one"`.
3. `tests/helpers/api-fixtures.ts` — a call fixture for `getInsights`.
4. `tests/integration/api/setup-permission.test.ts` — its own second table, `OTHER_FIXTURES`.
5. `docs/mcp.md` — the tool table **and** the prose count in `## 3. The 20 exposed tools` → `21`,
   parsed by `tests/integration/docs/mcp-docs.test.ts`.

Grep for the written-out number word as well as the digits: the counts appear as English words in
test names and as digits in headings. `pnpm vitest run tests/unit/mcp tests/integration/api
tests/integration/docs` catches all five locally.

## §6 Tests this contract owes

1. the body matches the screen's figures for a seeded project, per-platform, with sample sizes and
   "as of" (US7.1) — asserted by calling the same service the page calls and comparing;
2. a key for project A gets nothing of project B (US7.2);
3. a key without `read` is refused with the registry's standard error (US7.3);
4. a comparison below the floor returns the counts plus `conclusion: "not_enough_posts"` and **no**
   ordering (US7.4);
5. the operation appears in the REST router, the OpenAPI document and the MCP tool list, consistently
   with the single `mcp.expose` decision (US7.5, SC-008);
6. the secret scan over the response for a project with snapshots on every platform finds nothing
   (US7.6, FR-064, FR-084);
7. **no platform HTTP call is made** while serving it — a provider read invoked during the request
   fails the test (SC-011).
