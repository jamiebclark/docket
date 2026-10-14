# Feature Specification: An MCP server over the v1 API

**Feature Branch**: `074-mcp-server`

**Created**: 2026-10-14

**Status**: Draft

**Input**: User description: "Expose Docket to LLM clients through MCP, as a thin translation layer over the v1 API rather than a second implementation. The project already publishes an OpenAPI document (src/server/api/openapi.ts, src/server/api/operations/openapi.ts, built with zod-openapi) and already authenticates with API keys, so the tool surface should be derived from the operations table in src/server/api/operations/ rather than hand-maintained in parallel — a new operation should appear as a tool without a second edit, and a drift test should fail if the two ever diverge. Scope the exposed tools deliberately: reading posts, accounts and activity, composing and scheduling posts, and the setup operations from `setup-write-api`; keep destructive and irreversible operations either out or behind an explicit confirmation argument, and document which is which. Authentication uses an existing project-scoped API key with its existing permissions — no new credential type, no ambient access, and no operation reachable over MCP that the same key could not perform over HTTP. Tool descriptions matter more here than in a REST client, since a model picks tools from them: each needs the project scoping, the required permission and the failure modes stated plainly. Decide and record in docs/decisions.md how the server is hosted (a route in the Next app versus a separate process), and how the user's project is selected per session. Tests: tool-surface-matches-operations drift test, authentication and permission enforcement per tool, project isolation, and the secret-scan test. Document it in docs/ alongside docs/n8n.md so the API and MCP routes are presented as the two front doors onto the same operations. This entry does NOT add any capability that the v1 API lacks — if something is worth doing over MCP and has no endpoint, it belongs in an API entry first — and does NOT introduce a separate permission model."

## Context and sources

- **Product behaviour**: `docs/build-prompt.md` "Public API" — everything drivable over HTTP, one service layer behind every caller (constitution IV), project-scoped keys carrying permissions, an `Idempotency-Key` on every write, one documented error shape, and an OpenAPI document generated from the Zod schemas. This entry adds a second front door onto that same surface and no new surface of its own.
- **Judgement calls already logged**: `docs/decisions.md` — 009's "the key decides the project" (no project slug in any path), "keys belong to the project, not the person who made them", "actions taken with a key are attributed to the key (its name and creator)", idempotency records last 7 days and an in-flight duplicate gets 409; 073's `manage_setup` permission and "project creation makes the key's creator the owner and mints no key".
- **What already exists and is reused rather than reimplemented** (constitution IV):
  - `src/server/api/operations/` — the single operation table (34 operations) that the router, the OpenAPI document and the cross-project scope test all read. Each operation declares `id`, `method`, `path`, `permission`, `summary`, optional `description`, `tag`, Zod `params`/`query`/`body`, `responses`, `idempotent`, `idempotencyMode`, `resourceParams` and a `run` that calls exactly one service function.
  - `src/server/api/handle.ts` — the whole request pipeline: read the key, resolve its project scope, count it against its rate limit, check the operation's permission, read and parse the body, wrap writes in `runIdempotent` when an `Idempotency-Key` is present, and map service errors through `mapServiceError`. Steps 1–8 store nothing.
  - `src/server/api/auth.ts` — `readKey`, which takes the key from `Authorization: Bearer` or `X-API-Key` and never reads a cookie.
  - `src/server/api/errors.ts` — `API_ERROR_CODES`, `statusFor`, `mapServiceError`, `zodDetails`: the stable code/message/details/requestId error shape.
  - `src/server/api/openapi.ts` — the generated document, including `errorStatuses(op)` and `codesFor(status)`, which already derive *per operation* exactly which failures it can answer with.
  - `src/server/dal/scope.ts` — `forApiKey` and `KEY_GRANTS`, the one place a key's permissions become capabilities (`read`, `write_posts`, `generate`, `auto_approve`, `manage_jobs`, `manage_setup`).
  - `tests/integration/api/scope-enforcement.test.ts` — the existing "one fixture per operation id, and a test that fails when an operation has no fixture" pattern. The drift test this entry asks for is the same pattern applied to MCP exposure.
  - `tests/integration/security/secret-scan.test.ts` — the scan every new response path must pass.
  - `docs/n8n.md` — the existing front-door guide, which this entry's page sits beside.

### Constraints found while specifying (recorded for planning)

1. **MCP protocol facts are not in `docs/research/`.** There is no `docs/research/mcp.md`. Constitution I forbids taking the transport, the initialize handshake, the `tools/list` and `tools/call` message shapes, the tool-definition fields or the authorization convention from memory. **`NEEDS RESEARCH: docs/research/mcp.md`** — the Model Context Protocol wire format, transport choice and auth convention must be written up from the official specification before planning fixes the protocol surface. Everything else in this spec is settled without it.
2. **No MCP library is installed.** `package.json` has no `@modelcontextprotocol/*` dependency, and constitution VI both forbids hand-rolling a substitute and notes that pipeline phases cannot reach the npm registry. **`NEEDS DEPENDENCY: @modelcontextprotocol/sdk`** (or whichever package the research in constraint 1 identifies). Planning must treat the protocol layer as blocked on that install; the exposure field, the tool-surface derivation, the description generator and every test in this spec can be built and run without it.
3. **"Derived from the operations table" and "scoped deliberately" pull against each other.** A filter kept anywhere other than the operation definition *is* the parallel hand-maintained list this entry exists to avoid, and a new operation would silently inherit whatever the filter's default is. The resolution is in Decisions: exposure is a required field on the operation, so there is one edit, in one place, and it cannot be forgotten.
4. **There is no `listPosts` operation.** The table can `getPost` by id and `getPostTarget` by id, but nothing lists a project's posts. A model therefore cannot browse posts over MCP — it can only fetch one whose id it already learned from `createPost`, `generatePost` or `listActivity`. This entry must **not** add one: the roadmap is explicit that a missing capability belongs in an API entry first. It is recorded here as a known gap for a later API entry.
5. **One operation is multipart.** `uploadMedia` takes `multipart/form-data` and raw bytes, which a JSON tool call cannot carry. It is withheld on mechanical grounds, not policy ones.
6. **One operation has no permission.** `getOpenApi` is `permission: null` and public. It is withheld: a model does not need the document it is already being handed as tools, and it is the largest response the API produces.
7. **`Idempotency-Key` is an HTTP header.** `handle.ts` only reaches for idempotency when that header is present, and a tool call carries no headers of its own. A faithful translation needs somewhere for a caller to put the key; see Decisions.
8. **The key's rate limit is per minute and shared.** `forApiKey` counts every authenticated call against `rate_limit_per_minute` (default 60). A model calling tools in a loop hits the same bucket an n8n workflow would, and `handle.ts` answers 429 with `Retry-After`.
9. **A key is pinned to exactly one project.** `api_keys.project_id` is `NOT NULL` and `forApiKey` builds the scope around that project. "How the project is selected per session" therefore has an answer that already exists rather than one to invent.
10. **`auto_approve` grants no resource capability of its own.** In `KEY_GRANTS` it maps to `generation: ["auto_approve"]` only, and no operation declares it as its `permission`. It changes what `generatePost` does rather than whether a tool is callable, which the generate tool's description has to say out loud.

## Decisions made while specifying

Each is a judgement call to be appended to `docs/decisions.md` and reversible.

- **Exposure is a required field on the operation, not a filter beside the table.** Every entry in `OPERATIONS` declares its MCP disposition inline: exposed, exposed-behind-confirmation, or withheld with a one-line reason. The type system makes it non-optional, so a new operation cannot compile without its author deciding, and the decision is made in the same edit that adds the operation — satisfying "a new operation should appear as a tool without a second edit" while still scoping the surface deliberately. The drift test then has something to check that is not a copy of the table.
- **A route in the Next app, not a separate process.** The deployment is three containers (web, worker, postgres) and constitution VI makes new infrastructure a justified exception. Everything the MCP layer needs — `forApiKey`, the rate-limit counter, the permission check, the idempotency table, `mapServiceError` — lives in the web process already; a separate process would either duplicate them or talk to the web process over the very HTTP API it is translating. Hosting it as a route also means one origin, one TLS certificate and one set of secrets, and it keeps the "same key, same answers" equivalence trivially true. The cost accepted is that a long-lived MCP connection shares the web container's resources with the UI.
- **The key decides the project; there is no project selection step.** A key already belongs to one project (constraint 9), so the project for a session is whichever project the key the client was configured with belongs to. No tool takes a project id or slug, no tool switches project, and driving two projects means two configured server entries with two keys. This is 009's rule carried forward unchanged, and it is what makes the project-isolation test a statement about every tool at once rather than per tool.
- **Authentication is required before anything, including listing tools.** The key is read exactly as `readKey` reads it for HTTP, and an unauthenticated or revoked/expired key gets the same `invalid_api_key` refusal for a tool *listing* as for a tool call. Listing is not free information: the tool descriptions name the project. A cookie is never read, and a browser session confers nothing.
- **The exposed surface is 19 tools.** Reads (7): list accounts, list activity, get a post, get one target of a post, list the media library, get one image, list upcoming slots. Compose and schedule (4): create a draft post, generate a post, add a post to the queue, schedule a post at a time. Setup (8), all from 073: create a project, create a voice profile, update a voice profile, set an account's posting instructions, add a slot, add a week of slots, update a slot, delete a slot. Media *reads* are in because choosing an image is part of composing a post for an account that requires one; media *writes* are not.
- **Four of those nineteen require an explicit confirmation argument.** `queuePost` and `schedulePost`, because their effect is a post published to a brand's live accounts at a time the caller cannot take back; `deleteSlot`, because it destroys a schedule row with no undo; `createProject`, because it permanently consumes a globally unique slug and makes a project no API call can remove. The argument accepts only the literal value `true`; absent, `false` or anything else is a refusal that names the effect in plain words and names the argument to pass, and nothing happens. The argument lives in the tool's input schema so the model sees it when it chooses the tool, rather than relying on a client to put up a dialog.
- **Fifteen operations are withheld, each with a stated reason.** `getOpenApi` (constraint 6) and `uploadMedia` (constraint 5) on mechanical grounds. `registerMediaFromUrl` because it makes the server fetch an arbitrary URL on a model's say-so. The nine job operations (`listJobs`, `createJob`, `getJob`, `listJobItems`, `getJobItem`, `addJobItems`, `closeJob`, `cancelJob`, `retryFailedJobItems`) because batch jobs are a bulk-generation workflow, a model driving one conversationally would spend LLM credits in quantities nobody asked for, and `closeJob`/`cancelJob` are one-way. `retryPostTarget`, `resolvePostTarget` and `retryFailedTargets` because they are the ambiguous-publish recovery path: constitution V says a publish of unknown outcome is never retried automatically, and a model is the last thing that should decide a post did not go out. The list and the reasons are published, not buried in code comments.
- **Generation is exposed without confirmation, with its cost stated.** `generatePost` produces a draft and publishes nothing, so it is not irreversible; but it spends LLM credits and, with a key holding `auto_approve`, bypasses review. Its description says both out loud, and says that a validation failure still forces review even under auto-approve.
- **Write tools take an optional idempotency argument.** Constraint 7: each tool whose operation is `idempotent: true` accepts an optional string argument that is passed through as the `Idempotency-Key`. Validation, replay, the `Idempotent-Replayed` marker and the 409 for an in-flight duplicate are whatever `runIdempotent` already does. Omitting it behaves exactly as an HTTP call without the header. This is a translation of an existing affordance, not a new capability.
- **Tool names are `docket_` plus the operation id in snake_case, and are frozen once published.** `createPost` becomes `docket_create_post`. The prefix keeps Docket's tools apart in a client holding several servers, the derivation keeps the name a function of the table, and a test asserts the generated names against a committed list so a rename of an operation id cannot silently break a client's saved instructions.
- **Tool descriptions are generated, not written by hand, and their required parts are tested.** Each description is assembled from the operation's own `summary` and `description` plus four generated sentences: the project it acts on and that it cannot act on another; the exact permission the key must hold; the failures it can answer with, derived from the same `errorStatuses`/`codesFor` logic the OpenAPI document uses; and, for the four confirmation tools, what it will do and what to pass. Hand-written per-tool prose would drift from the operation the moment either changed. A test asserts every exposed tool's description contains all four parts.
- **Every tool call runs the same pipeline as an HTTP request.** The MCP layer's job is to turn a tool call into the inputs `handle.ts` already takes and turn the result back, so authentication, rate limiting, permission checking, input parsing, idempotency, service-error mapping and the request id are shared code rather than a second implementation. The equivalence the roadmap asks for — nothing reachable over MCP that the same key could not do over HTTP — is then a property of the design, and the test only has to confirm it holds for every tool.
- **Errors reach the model as the API's error shape in a tool error.** Code, message and request id, exactly as the HTTP API would answer. No stack traces, no credentials, no internal identifiers from another project, and 429 keeps its wait so a client can back off rather than hammer.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read a brand's state and compose a post from a chat client (Priority: P1)

A person running Docket for a brand has their LLM client configured with that project's API key. They ask it what is going out this week and what failed; it lists the project's upcoming slots and recent publishing activity. They then describe a post in a sentence; the client generates it for the brand's connected accounts, shows them the draft text, and — only after they say yes and the model passes the confirmation argument — adds it to the queue. Nothing reaches a social account until that confirmation.

**Why this priority**: It is the whole point of the entry: driving Docket conversationally for the everyday loop of looking at the week and getting a post out. It uses only read and write tools that already exist as endpoints, so it is testable the moment the tool surface and the pipeline bridge are in place.

**Independent Test**: Configure one project's key, list the tools, call the read tools and compare their results against the same operations called over HTTP with the same key, generate a post, then call the queue tool first without the confirmation argument (expecting a refusal and no change) and then with it (expecting the post queued into a real slot).

**Acceptance Scenarios**:

1. **Given** a client configured with a key holding `read`, **When** it lists the available tools, **Then** it is given exactly the nineteen exposed tools, each description naming the project the key belongs to, the permission it requires and the failures it can answer with.
2. **Given** that same key, **When** the client calls the activity and upcoming-slots tools, **Then** the results are the same data the identical HTTP operations return for that key, and nothing from any other project appears.
3. **Given** a key holding `read` and `generate`, **When** the client generates a post for two connected accounts, **Then** a draft post exists with text for each account and the tool result carries the post's id.
4. **Given** that draft, **When** the client calls the queue tool with no confirmation argument, **Then** the call is refused with a message naming what queueing would do and naming the argument to pass, and the post is still a draft.
5. **Given** that same draft, **When** the client calls the queue tool with the confirmation argument set, **Then** the post is queued into the account's next free slot, exactly as the HTTP queue operation would have done.
6. **Given** a key holding `read` only, **When** the client calls the generate tool, **Then** it is refused with the same missing-permission code and message the HTTP API gives, and no generation runs and no credit is spent.

---

### User Story 2 - Stand a brand up conversationally (Priority: P2)

An operator onboarding a new brand works through it in conversation instead of a browser: the client creates the project (after an explicit confirmation, because the slug is permanent), writes the brand's voice profile, sets each account's posting instructions, and books the posting week. Re-running a step after a dropped connection does not create a second project or a second profile, because the client passes the same idempotency argument.

**Why this priority**: It is the payoff of `setup-write-api` and the reason this entry is last in the roadmap, but it is independent of Story 1 — it exercises a different permission (`manage_setup`) and a different set of tools, and delivers value on its own to anyone who onboards brands.

**Independent Test**: With a key holding `manage_setup`, call the project, voice-profile, posting-instructions and slot tools in sequence, confirm through the read tools and through the UI that the project exists with what was submitted, then replay each write with the same idempotency argument and confirm nothing is duplicated.

**Acceptance Scenarios**:

1. **Given** a key holding `manage_setup`, **When** the client calls the create-project tool with the confirmation argument and an unused slug, **Then** the project exists with the submitted name, slug, timezone, policy defaults and brand fields, and the tool result is the same body the HTTP operation returns.
2. **Given** the same call without the confirmation argument, **When** it is made, **Then** it is refused with a message saying the slug is permanent and the project cannot be removed over the API, and no project is created.
3. **Given** a slug held by a project the key cannot see, **When** the client creates a project with it, **Then** the refusal is the same conflict, with the same code, message and details, as for a slug held by a project it can see.
4. **Given** a key holding `manage_setup`, **When** the client books a time on every weekday for an account and then calls the same tool again with the same idempotency argument, **Then** the slots exist once and the second call replays the first result.
5. **Given** a key holding `manage_setup`, **When** the client calls the delete-slot tool without the confirmation argument, **Then** it is refused and the slot still exists; **and when** it calls it with the argument, **Then** the slot is gone.
6. **Given** a key holding `write_posts` but not `manage_setup`, **When** the client calls any setup tool, **Then** each is refused with the missing-permission code naming `manage_setup`, and nothing is written.

---

### User Story 3 - A new API operation becomes a tool, or is deliberately withheld, in one edit (Priority: P2)

A developer adds an operation to the v1 API in a later entry. They declare its MCP disposition in the same definition they just wrote. If they say expose it, it is a tool on the next start — with a derived name, a derived input schema and a derived description — with no second file touched. If they forget to decide, the build and the test suite tell them before review does.

**Why this priority**: It is the maintenance property the entry is really buying, and the thing the drift test exists to protect. It is independently testable with no MCP client at all.

**Independent Test**: Add a throwaway operation to the table in a test fixture without a disposition and confirm the drift test fails; give it one and confirm it appears in, or is absent from, the derived tool list accordingly, with a name, schema and description generated from it.

**Acceptance Scenarios**:

1. **Given** an operation with no MCP disposition, **When** the test suite runs, **Then** the drift test fails naming that operation id.
2. **Given** an operation marked exposed, **When** the tool list is derived, **Then** it contains exactly one tool for it, whose name follows the documented derivation, whose input schema accepts exactly the operation's own path, query and body fields, and whose description carries all four required parts.
3. **Given** an operation marked withheld, **When** the tool list is derived, **Then** no tool exists for it, and its recorded reason appears in the published list of withheld operations.
4. **Given** a tool whose name does not match the committed name list, **When** the test suite runs, **Then** it fails, so an operation id rename cannot silently rename a published tool.
5. **Given** the derived tool list, **When** the test suite checks it against the operation table, **Then** every tool maps to exactly one operation and every exposed operation maps to exactly one tool — no orphan tools, no un-toolled exposures.

---

### Edge Cases

- **No key, or a key presented in a way the API does not accept.** Refused with `invalid_api_key`, for listing as well as calling. Nothing about the project is disclosed, including whether the host has projects at all.
- **A revoked or expired key, or one revoked mid-session.** The next request after revocation is refused; a connection opened earlier confers nothing, because the key is resolved per request exactly as it is over HTTP.
- **A browser session cookie and no key.** Refused. A signed-in browser is not an MCP credential, and no tool is reachable with ambient access.
- **A resource id belonging to another project** passed to any tool taking an id. Answered as not found, with the identical code and message as for an id that does not exist anywhere, so the tool cannot be used to probe for other projects' records.
- **The model invents a project id or slug argument** on a tool that has none. A validation failure naming the unknown field, not a silent ignore.
- **The key's rate limit is reached** mid-conversation. The tool answers with the rate-limited code and the seconds to wait, so the client backs off rather than retrying immediately; the limit is the same bucket the key's HTTP traffic uses.
- **A confirmation argument set to a string `"true"`, to `1`, or to `false`.** Only the literal boolean `true` proceeds; anything else is the same refusal as omitting it.
- **The same idempotency argument sent with a different body.** Whatever `runIdempotent` already does for a mismatched replay over HTTP, unchanged.
- **Two tool calls with the same idempotency argument in flight at once** — a model retrying before the first returns. The second gets the in-flight conflict, as over HTTP.
- **A generation refused for billing** by the LLM provider. The existing credit-hold behaviour applies and the tool reports the same refusal; it does not retry on the model's behalf.
- **An operation whose service is not configured** (media storage absent, no LLM credential for the project). The same not-configured refusal as over HTTP, with the same wording, so the model can tell the person what to set up.
- **A tool result large enough to be unwieldy** — a long activity list or media library. The operations' existing pagination and cursors carry over; the tool does not invent a different limit.
- **An operation's schema changes in a later entry.** The tool's input schema changes with it on the next start, because it is derived; nothing needs editing, and the drift test confirms they still match.

## Requirements *(mandatory)*

### Functional Requirements

**Tool surface derived from the operations table**

- **FR-001**: Every operation in the API operation table MUST declare its MCP disposition on the operation itself — exposed, exposed requiring confirmation, or withheld with a stated reason — and the declaration MUST be mandatory, so an operation cannot exist without one.
- **FR-002**: The tool list MUST be computed from the operation table, such that adding an operation with a disposition of exposed makes it available as a tool with no other file edited.
- **FR-003**: A drift test MUST fail when any operation lacks a disposition, when the derived tool list is not exactly the set of exposed operations, or when a tool's name, required permission or input schema does not match its operation.
- **FR-004**: Each tool's name MUST be derived from its operation's id by a documented rule, and MUST be asserted against a committed list of published names so that renaming an operation id cannot silently rename a tool.
- **FR-005**: Each tool's input schema MUST be derived from its operation's own path-parameter, query and body schemas, accepting exactly those fields and rejecting unknown ones; no tool may carry a hand-written duplicate of a schema the operation already declares.
- **FR-006**: Each exposed tool's description MUST be generated and MUST state, in plain language: the project it acts on and that it cannot act on any other; the exact key permission required; the failure modes it can answer with, derived from the same per-operation logic the OpenAPI document uses; and, for confirmation tools, the effect being confirmed and the argument to pass.
- **FR-007**: A test MUST assert that every exposed tool's description contains each of the four parts required by FR-006.

**Authentication, permissions and equivalence**

- **FR-008**: MCP access MUST authenticate with an existing project-scoped API key, read the same ways the HTTP API accepts one. No new credential type, no new permission value, and no change to the permission model.
- **FR-009**: Authentication MUST be required before any MCP request is served, including listing tools; an absent, malformed, revoked or expired key MUST be refused with the same code and message the HTTP API gives.
- **FR-010**: No MCP request may be served on the strength of a browser session, a cookie, or any ambient credential.
- **FR-011**: Every tool call MUST be served through the same request pipeline as the equivalent HTTP request — key resolution, rate limiting, permission check, input parsing, idempotency and service-error mapping — rather than a second implementation of any of those steps.
- **FR-012**: A tool call with a key that lacks the operation's permission MUST be refused with the same code, message and permission name as the HTTP API, with no side effect and no resource disclosure.
- **FR-013**: A test MUST assert, for every exposed tool, that a key lacking its permission is refused and that a key holding it succeeds.
- **FR-014**: No tool may exist that does not correspond to exactly one operation in the table, and no tool may accept an input, or produce an effect, that the same key could not achieve by calling that operation over HTTP. A test MUST assert this correspondence for the whole surface.
- **FR-015**: The key's existing rate limit MUST apply to MCP traffic, counted in the same bucket as its HTTP traffic, and a rate-limited tool call MUST report the wait before retrying.

**Project scoping and isolation**

- **FR-016**: The project a session acts on MUST be determined solely by the API key presented. No tool may accept a project identifier, and no mechanism may switch project within a session.
- **FR-017**: A tool call naming a resource that belongs to another project MUST be answered as not found, indistinguishably from a resource that does not exist at all.
- **FR-018**: A test MUST assert project isolation for every exposed tool that takes a resource identifier, using a resource from a second project.

**Deliberate scoping, confirmation and withholding**

- **FR-019**: The exposed surface MUST cover reading accounts, publishing activity, individual posts and their targets, the media library and upcoming slots; composing, generating, queueing and scheduling posts; and the project, voice-profile, posting-instruction and slot setup operations.
- **FR-020**: Operations whose effect is irreversible or destructive MUST either be withheld or require an explicit confirmation argument. The argument MUST appear in the tool's own input schema, MUST accept only an affirmative boolean value, and when absent or not affirmative MUST produce a refusal that names the effect and the argument, with no side effect.
- **FR-021**: Queueing a post, scheduling a post, deleting a slot and creating a project MUST require that confirmation argument.
- **FR-022**: The ambiguous-publish recovery operations (retrying a target, resolving a target, retrying all failed targets) MUST NOT be exposed, because a publish of unknown outcome is never retried automatically.
- **FR-023**: Batch-job operations, media upload, media import from a URL and the OpenAPI document operation MUST NOT be exposed.
- **FR-024**: Each withheld operation's reason MUST be recorded alongside its declaration and published in the documentation, so the surface is explicable without reading code.
- **FR-025**: Each tool whose operation is idempotent MUST accept an optional idempotency argument that behaves exactly as the HTTP idempotency header does, including replay, replay marking and the conflict for an in-flight duplicate.
- **FR-026**: The generation tool's description MUST state that it spends the project's LLM budget, that a key holding the auto-approve permission skips review, and that a validation failure still forces review even then.
- **FR-027**: This entry MUST NOT add, alter or remove any v1 API operation, request shape or response shape, and MUST NOT add a capability the v1 API lacks. The absence of a list-posts operation MUST be recorded as a gap for a later API entry rather than filled here.

**Errors, secrets and operability**

- **FR-028**: Tool failures MUST be reported to the client using the API's existing error shape — stable code, human message and request id — and MUST NOT include stack traces, internal identifiers from other projects, or any credential.
- **FR-029**: No API key, provider token or other secret may appear in any MCP response, tool description, tool result or log line; the existing secret scan MUST cover the MCP path and stay green.
- **FR-030**: The hosting choice (a route in the Next application rather than a separate process) and the per-session project rule MUST be recorded in `docs/decisions.md` with their reasoning and their accepted costs.

**Documentation**

- **FR-031**: A documentation page MUST be published in `docs/` beside `docs/n8n.md`, added to the site navigation, presenting the HTTP API and MCP as two front doors onto the same operations, and covering: creating and configuring a key, which permissions each tool needs, the full list of exposed tools, the confirmation tools and why, the withheld operations and why, and the two-projects-two-servers rule.
- **FR-032**: `docs/n8n.md` MUST cross-reference the new page, and the new page MUST cross-reference it, so neither reads as the only way in.
- **FR-033**: `docs/security.md` MUST be updated to state that MCP uses the same keys, the same permissions and the same project scoping, and adds no new credential type or trust boundary.

### Key Entities

- **API key** (existing, unchanged): belongs to exactly one project, carries a set of permissions, a rate limit and an optional expiry. It is the only credential MCP accepts, and it is what selects the project for a session.
- **API operation** (existing, gains one required field): the single declaration of a v1 endpoint — its id, method, path, required permission, summary, input schemas, responses and idempotency. It gains a mandatory MCP disposition: exposed, exposed requiring confirmation, or withheld with a reason.
- **MCP tool** (new, derived, not stored): one per exposed operation. Its name, input schema, description and required permission are all functions of its operation; nothing about it is maintained by hand.
- **Confirmation argument** (new, part of a tool's input schema): the affirmative value a caller must supply before an irreversible tool acts.
- **Idempotency argument** (new, part of a tool's input schema): the optional caller-supplied key that gives a write the same replay behaviour an HTTP write gets from its header.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With nothing but one project's existing API key configured, a person can, in a single conversation with an LLM client, see what is scheduled and what failed, get a post written for their connected accounts, and put it in the queue — with no browser step and no second credential.
- **SC-002**: Adding a new v1 operation takes exactly one edit for it to become a tool or be deliberately withheld: the operation's own definition. Omitting the decision fails the test suite rather than reaching review.
- **SC-003**: Every exposed tool is covered by a permission test and, where it takes a resource identifier, by a cross-project test; a key missing a tool's permission is refused 100% of the time, and a resource from another project is never reachable through any tool.
- **SC-004**: No tool, and no tool listing, is obtainable without a valid project-scoped API key — including with a signed-in browser session.
- **SC-005**: Each of the four irreversible tools refuses every call that omits its confirmation, with no side effect, and the refusal names both the effect and the argument.
- **SC-006**: Every exposed tool's description states the project scoping, the required permission and the failure modes; this is verified by test rather than by reading, so it cannot rot.
- **SC-007**: The secret scan passes over the MCP path: no key, token or other secret appears in any response, description, result or log line.
- **SC-008**: Every one of the 34 operations is accounted for in the published documentation as exposed, exposed-with-confirmation, or withheld-because-X — a reader can tell what an LLM client can and cannot do without reading the source.
- **SC-009**: For every exposed tool, a call and the equivalent HTTP request made with the same key return the same outcome, so the two front doors can be documented as one surface without a caveat list.

## Assumptions

- **The reader of the documentation is an operator, not a developer.** The page explains which permissions to tick and what each tool will do, in the register `docs/n8n.md` uses.
- **The client is a general LLM client**, configured by pasting a server address and a key. No Docket-specific client is built, and no client-side UI is assumed — which is exactly why the confirmation lives in the tool's arguments rather than in a dialog.
- **One key, one project, per configured server.** Someone running several brands configures several servers. Nothing is built to make a single session span projects.
- **Permissions are unchanged.** The five permissions that grant capabilities today (`read`, `write_posts`, `generate`, `manage_jobs`, `manage_setup`) plus `auto_approve` are the whole model; `manage_jobs` happens to grant nothing reachable over MCP, since the job operations are withheld.
- **The derived tool surface is computed at startup**, not stored, so there is no migration and nothing to keep in sync with the database.
- **Existing pagination and limits carry over unchanged**; the MCP layer does not impose its own page sizes, body limits or timeouts beyond what the HTTP pipeline already applies.
- **The protocol layer is the only blocked part.** Constraints 1 and 2 mean planning must produce `docs/research/mcp.md` and flag `NEEDS DEPENDENCY` for the protocol library; the exposure field, the derivation, the description generator, the confirmation and idempotency arguments, the drift test, the permission tests, the isolation tests and the documentation can all be built and verified without the protocol library being present.
- **No capability is added.** Where an LLM client would plausibly want something the API cannot do — listing a project's posts is the clear case (constraint 4) — it is recorded as a gap for a later API entry, not implemented here.
