# Driving Docket from an MCP client

Docket also answers [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) requests at `/api/mcp`, so a chat client — Claude, or any client that speaks MCP over Streamable HTTP — can read a project's state and compose, queue, schedule and set up a brand in conversation. MCP and the public API ([`docs/n8n.md`](n8n.md)) are two front doors onto the same operations: the same key, the same permissions, the same project scoping, and no extra capability either door can reach that the other cannot.

## 1. Create a key

Same as for the public API: in the project, open **Settings → API keys → Create key**. Tick the permissions the tools you want need (section 3 below), pick a rate limit and an expiry, and copy the secret (`dkt_…`) once — it is shown only at creation.

## 2. Configure a client

Point your MCP client at `{{base}}/api/mcp` and give it the key as a bearer credential (`Authorization: Bearer dkt_…`), exactly as you would configure the header for the public API. There is no separate MCP credential and no browser session involved — a signed-in browser confers nothing to an MCP client, and listing tools requires the same valid key as calling one.

## 3. The 19 exposed tools

The key decides the project: there is no project-selection tool, and no tool takes a project id. Running two brands means two configured servers with two keys — see section 6.

Four tools demand an explicit `confirm: true` argument because their effect cannot be undone through the API. Passing anything else — omitted, `false`, `"true"`, `1` — is refused, names the effect and the argument, and has no side effect.

| Tool | Permission | Confirm | Effect |
|---|---|---|---|
| `docket_list_accounts` | `read` | | Lists the project's connected accounts. |
| `docket_list_activity` | `read` | | Lists what happened to publishing, newest first. |
| `docket_get_post` | `read` | | Reads one post. |
| `docket_get_post_target` | `read` | | Reads one target of a post. |
| `docket_list_media` | `read` | | Lists the media library. |
| `docket_get_media` | `read` | | Reads one media item. |
| `docket_list_upcoming_slots` | `read` | | Lists upcoming posting slots. |
| `docket_create_post` | `write_posts` | | Creates a draft post. |
| `docket_generate_post` | `generate` | conditional | Generates a post, spending the project's LLM budget. If a key holding `auto_approve` is used, the result skips review — unless generation fails validation, which still forces review. Requires `confirm: true` unless `schedulingPolicy` is explicitly `leave_as_draft` — an absent policy falls back to the project's default, which may queue, so only an explicit `leave_as_draft` call skips confirmation. |
| `docket_queue_post` | `write_posts` | **yes** | Adds a post to the account's queue — it goes out at the next free slot. |
| `docket_schedule_post` | `write_posts` | **yes** | Schedules a post at a specific time. |
| `docket_create_project` | `manage_setup` | **yes** | Creates a project. The slug is permanent and the project cannot be removed over the API. |
| `docket_create_voice_profile` | `manage_setup` | | Creates a voice profile. |
| `docket_update_voice_profile` | `manage_setup` | | Updates a voice profile. |
| `docket_set_account_posting_instructions` | `manage_setup` | | Sets an account's posting instructions. |
| `docket_add_slot` | `manage_setup` | | Adds one posting slot. |
| `docket_add_week_slots` | `manage_setup` | | Books a time on every weekday. |
| `docket_update_slot` | `manage_setup` | | Updates a slot. |
| `docket_delete_slot` | `manage_setup` | **yes** | Deletes a slot — no undo. |

Every write tool whose operation is idempotent (all twelve above) accepts an optional `idempotencyKey` string argument, which behaves exactly like the `Idempotency-Key` header does over HTTP: a replay with the same key and the same body returns the first result instead of acting twice; a replay with a different body is refused; two calls with the same key in flight at once get the in-flight conflict.

Each tool's description, generated from its operation rather than hand-written, states the project it acts on, the permission it needs, and the failures it can answer with — so a client can be asked what a tool does and get an answer that cannot drift from the code.

## 4. The 15 withheld operations

These exist in the public API but have no MCP tool, each for a stated reason:

| Operation | Reason |
|---|---|
| `getOpenApi` | Public and unauthenticated, and the largest response the API produces; a model is already holding the tool list it describes. |
| `uploadMedia` | Multipart upload of raw bytes, which a JSON tool call cannot carry. |
| `registerMediaFromUrl` | Would make the server fetch an arbitrary URL on a model's say-so. |
| `listJobs`, `createJob`, `getJob`, `listJobItems`, `getJobItem`, `addJobItems`, `retryFailedJobItems` | Batch generation is a bulk workflow; a model driving one conversationally would spend LLM credits in quantities nobody asked for. |
| `closeJob`, `cancelJob` | As above, and one-way. |
| `retryPostTarget`, `resolvePostTarget`, `retryFailedTargets` | The ambiguous-publish recovery path. A publish of unknown outcome is never retried automatically, and a model is the last thing that should decide a post did not go out — use the public API or the UI for recovery. |

Nothing above is reachable through MCP by any key, regardless of permissions: a withheld operation has no tool at all, not a tool a key happens to lack permission for.

## 5. Two projects, two servers

A key belongs to exactly one project, and that is the only thing that decides which project an MCP session acts on. There is no tool to switch project and no tool accepts a project id or slug — a resource id from another project is answered as not found, identically to an id that does not exist anywhere. Running several brands through the same client means configuring several server entries, one key each.

## 6. Errors

A tool failure carries the same code, human message and request id the public API would give for the same call — no stack trace, no credential, no internal id from another project. A key missing a tool's permission is refused with the same missing-permission code and message the HTTP API gives, with no side effect. A rate-limited call reports the wait before retrying, counted in the same bucket as the key's HTTP traffic.

See also [`docs/n8n.md`](n8n.md) for driving Docket over plain HTTP — the same operations, the same keys, without an MCP client.
