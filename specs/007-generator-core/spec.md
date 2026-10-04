# Feature Specification: Generator core (LLM layer, voice profiles, single and series generation, approval policy, review queue)

**Feature Branch**: `007-generator-core`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "Build the generator core. Before specifying, read docs/build-prompt.md ('Generator' — Voice and context, LLM layer, Three modes (single and series only here), Approval policy — and 'Owner answers': implement OpenAI first, then Anthropic, models from env), docs/research/llm-and-storage.md (authoritative SDK facts: OpenAI Responses API with zodTextFormat; Anthropic structured outputs with zodOutputFormat and its schema limitations; image input formats and limits; timeouts/retries), .specify/memory/constitution.md, the docket-ui skill and docs/decisions.md. Must deliver: an LlmProvider interface (structured generation with a Zod schema, optional image inputs by URL or bytes, timeout, usage/latency reporting) with OpenAI and Anthropic implementations selected by env (LLM_PROVIDER, LLM_MODEL, API keys) — no hardcoded model names; a fake LLM for tests. Voice profiles (project-scoped, multiple, one default set on the project): voice and tone, audience, topics/pillars, avoid list, example posts, preferred links and hashtags, per-platform guidance; versioned (immutable versions, edits create a new version); UI to edit and a 'try it' panel that generates sample posts without saving. Generation core: builds prompts from voice profile version + one-off instructions + inputs + target accounts' provider capabilities; output schema with one variant per target platform respecting that platform's limits and media requirement; Zod validation plus provider validate(); on failure retry once with the errors, then record the failure; store prompt, model, provider, voice profile version, inputs and latency in posts' generation metadata. Modes: single post (brief, optional pasted source text, target accounts, optional media incl. image input to the model) returning editable drafts with regenerate; series (brief + N -> a plan of distinct angles shown for editing -> write posts). Approval policy service (one implementation): review_required -> needs_review; auto_approve -> approved, but any post failing platform validation always goes to review; scheduling policy leave_as_draft | add_to_queue (uses entry 2's slot allocation service); project defaults with per-call override limited by role; the auto_approve + add_to_queue combination is an explicit, clearly labelled choice. Review queue screen: approve, edit then approve, reject, regenerate, bulk approve. A clean extension point (interface only) for future image generation. Tests: prompt assembly, structured-output validation and single retry, approval/scheduling policy matrix incl. validation failure forcing review, role limits on overrides, voice profile versioning; LLM calls mocked. Measure and log real call latency where a key is configured; otherwise report it as unmeasured. Must NOT do: generation jobs, batch mode and item sources (generation-jobs), public API (public-api)."

## Context and sources

- Product behaviour: `docs/build-prompt.md` → "Generator" ("Voice and context", "LLM layer", "Three modes" items 1 and 2 only, "Approval policy"), "Members and invitations" (roles), "Posting slots and the queue", "UI", and "Owner answers" item 1 (implement both OpenAI and Anthropic behind one interface, **OpenAI first**, model names from env).
- External facts: `docs/research/llm-and-storage.md` sections 1 and 2 (checked 2026-10-03). Where it disagrees with the brief, the research wins.
- Existing engine facts relied on (from `docs/decisions.md` 002/003 and the current code):
  - Projects already store `default_approval_policy` (`review_required` | `auto_approve`, default `review_required`) and `default_scheduling_policy` (`leave_as_draft` | `add_to_queue`, default `leave_as_draft`), and the settings screen already edits them.
  - Posts already have `origin` (`manual` | `generated` | `api`), a stored review state (`draft` | `needs_review` | `approved`), a derived `status`, and a `generation_metadata` field. One post has one target per social account, each with an optional per-platform content override.
  - Adding a post to the queue, the slot allocation it uses, and content validation against provider capabilities (`planImage` then `validateTargetContent`) each have exactly one implementation (constitution IV). This feature calls them; it does not reimplement them.
  - Each provider declares capabilities (text limit and its counting rule, media requirement, text-only allowed, image count, mime types, byte limits, alt-text limit) and a `validate()` function.
- Dependencies `openai` and `@anthropic-ai/sdk` are already installed (`docs/decisions.md` #19). No new runtime dependency is expected.

**Brief vs research (research wins):**

| Topic | Brief says | Research says (used here) |
|---|---|---|
| Structured output | "Output is structured and Zod-validated" | OpenAI: Responses API with a Zod-derived text format; parsed value returned. Anthropic: native structured outputs with a Zod-derived output format. Both helpers accept Zod 4 per their peer ranges. |
| Length limits in the schema | "variant per target platform that respects that platform's capabilities (length…)" | Anthropic's structured-output schema **cannot express** `minLength`/`maxLength`, `minimum`/`maximum`, or `minItems` above 1; OpenAI's helper cannot express refinements or transforms and requires every property (absent values must be nullable). So platform limits are **stated in the prompt and enforced after the call** by our own schema check plus the provider's `validate()`, never trusted to the model's schema alone. |
| Refusal and truncation | not stated | Both providers can return a refusal or an incomplete response that does not match the schema; these must be treated as failed attempts. |
| Image input | "the interface must accept image input" | Both accept an image by public URL or by inline bytes (base64). Common formats: JPEG, PNG, WebP, non-animated GIF. Anthropic: at most 10 MB per image, 8000×8000 px, 32 MB per request. OpenAI: 512 MB per request. |
| Timeouts and retries | not stated | Both SDKs default to a 10-minute timeout and 2 automatic retries (connection errors, 408, 429, 5xx; Anthropic also 409). Docket sets its own shorter timeout (FR-006). |
| Model names | "Do not hardcode a model name" | Model ids change often; the research lists current ids only as examples. Model comes from env only. |

**UNVERIFIED or NEEDS RESEARCH** (phases cannot fetch the web; planning uses the interim value shown, keeps it in one constant, records it in `docs/decisions.md` and covers it with mocked tests):

- R1 (UNVERIFIED): OpenAI's per-image byte limit and whether it fetches image URLs server-side with any reachability rules. *Interim*: images are sent within Anthropic's stricter limits (≤ 10 MB, ≤ 8000×8000 px, a format both accept) for both providers, using an existing media variant or a resized copy when the original is larger.
- R2 (UNVERIFIED): the exact OpenAI image content-part shape for the Responses API. *Interim*: take it from the installed `openai` package's own types.
- R3 (UNVERIFIED): whether Anthropic's Zod helper handles the installed Zod 4 schemas. *Interim*: check against the installed package's types and a fake-transport test; if it does not, build the JSON schema with Zod 4's own JSON Schema output and parse the result ourselves.
- R4 (UNVERIFIED): Anthropic structured-output complexity limits (24 optional parameters, 16 union-typed parameters) against a schema with one variant per platform. *Interim*: the output schema uses only required properties and no unions beyond nullable fields, which stays well inside the limits for up to the four current platforms.

## Decisions made while specifying

Made by the specify phase from the brief and existing behaviour; recorded so the owner can overturn them in `docs/decisions.md`.

- Single-post results are saved as posts as soon as they are generated, so nothing is lost on navigation, and the approval and scheduling policies are applied at that moment. "Editable drafts" means the result screen lets the person edit or regenerate each post while it has not been scheduled.
- A post whose platform validation still fails after the one retry is saved and always placed in review with its problems listed. A response that cannot be read at all (malformed, refused, truncated, timed out) after the one retry saves no post; the failure is recorded and shown.
- The scheduling policy chosen at generation time is remembered on the post. For `auto_approve` it is applied immediately; for `review_required` it is applied when a reviewer approves the post.
- Editors may override the approval policy only toward review (`review_required`); choosing `auto_approve` as an override requires owner or admin. Every member who can generate may choose either scheduling policy, because editors can already schedule posts.
- Rejected posts leave the review queue, are never scheduled, and stay visible under a "Rejected" filter in the post list.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Generate a single post for several accounts (Priority: P1)

An editor opens Generate → Single, picks a voice profile (the project default is preselected), types a brief, optionally pastes source text and adds one-off instructions, picks two or more of the project's accounts on different platforms, and optionally attaches an image from the media library. Docket sends the model the voice, the instructions, the inputs, the image, and each target platform's rules, and returns one post with a separate variant for each platform. The editor sees each variant with its live character count and any problems, edits a variant if needed, or regenerates the post with a further instruction.

**Why this priority**: It is the smallest end-to-end slice that proves the LLM layer, prompt assembly, structured output, validation and saving with metadata; series and review build on it.

**Independent Test**: With the fake LLM scripted to return a valid response, generate for a Bluesky and a Facebook account with an attached image. Confirm one post exists with origin "generated", one target per account, each target's content equal to its platform variant, the image attached, and generation metadata holding the assembled prompt, provider name, model name, voice profile version, all inputs, usage and latency. Confirm the prompt sent to the fake contains the voice profile fields, the instructions, the brief, the source text, each platform's limit and counting rule, and the image.

**Acceptance Scenarios**:

1. **Given** a project with a default voice profile and an LLM configured, **When** an editor generates a single post for accounts on two platforms, **Then** one post is created with one variant per platform, each target uses its platform's variant, and the result screen shows each variant with `used / limit` counts from that platform's own counting rule.
2. **Given** two target accounts on the same platform, **When** generating, **Then** the model is asked for one variant for that platform and both targets use it.
3. **Given** an attached image, **When** generating, **Then** the image is sent to the model as image input (by public URL when the asset is publicly reachable, otherwise as bytes within the model's limits) and attached to the post's targets that allow images.
4. **Given** the model's first response is readable but a variant breaks its platform's rules (for example Bluesky text over 300 graphemes), **When** generation runs, **Then** Docket asks the model once more, telling it exactly which rules were broken, and uses the second response.
5. **Given** a generated post on the result screen, **When** the editor edits a variant's text, **Then** the change is saved to that platform's targets and re-validated with the same checks as the composer.
6. **Given** a generated post not yet scheduled, **When** the editor chooses Regenerate with an optional extra instruction, **Then** the post's content is replaced by a new generation using the same inputs plus the instruction, the new generation's metadata is recorded, and the earlier generation's record is kept.
7. **Given** the project's policies are `review_required` + `leave_as_draft`, **When** a post is generated, **Then** it is in review (`needs_review`) and appears in the review queue.
8. **Given** no LLM is configured, **When** anyone opens Generate, **Then** the screen says generation is not configured and names the settings to set, and the rest of the app works normally.

---

### User Story 2 - Edit voice profiles and tune them with "Try it" (Priority: P1)

An owner or admin opens Voice, creates a profile with voice and tone, audience, topics and content pillars, things to avoid, example posts, preferred links, preferred hashtags, and guidance per platform, and marks it as the project default. Later they edit it; Docket keeps the old version unchanged and makes the edit a new version. On the same screen, a "Try it" panel generates sample posts from the profile as currently shown (including unsaved edits) for chosen platforms, without saving anything.

**Why this priority**: Every generation depends on a voice profile; without one the generator cannot produce posts in the project's voice.

**Independent Test**: Create a profile (version 1), set it as default, edit the tone (version 2), and confirm version 1 is unchanged and still readable, the profile's current version is 2, and a post generated before the edit still names version 1. Run "Try it" with unsaved changes and confirm samples are returned and no post, version or metadata row was written.

**Acceptance Scenarios**:

1. **Given** an owner or admin, **When** they create a voice profile, **Then** it is saved as version 1 of a new profile in that project.
2. **Given** a profile at version N, **When** an owner or admin saves an edit, **Then** version N+1 is created with the new content, version N is unchanged, and the profile's current version is N+1.
3. **Given** two people editing the same profile from version N, **When** the second saves after the first, **Then** the second save is refused with "This profile changed since you opened it" and the newer version is shown; nothing is overwritten.
4. **Given** several profiles, **When** an owner or admin marks one as default, **Then** it becomes the project's default and is preselected on Generate.
5. **Given** the default profile, **When** someone tries to archive it, **Then** it is refused until another profile is made the default.
6. **Given** an archived profile, **Then** it is hidden from Generate, its versions stay readable from posts that used them, and it can be restored.
7. **Given** the Try it panel with unsaved edits and one or more platforms chosen, **When** "Try it" runs, **Then** sample variants are shown with counts and validation problems, and nothing is saved.
8. **Given** an editor, **Then** they can view profiles and their version history and use Try it against a saved version, but cannot create, edit, archive, restore or set a default; such requests are refused on the server.
9. **Given** a profile's history, **When** someone opens it, **Then** they see each version's number, author and time, and can view any version's content.

---

### User Story 3 - Review queue: approve, edit then approve, reject, regenerate, bulk approve (Priority: P1)

An editor opens Review and sees every post waiting for review in the project, newest first, each with its platform variants, counts, any validation problems, the voice profile version and the brief that produced it. They approve good posts, fix and approve others, reject bad ones, regenerate ones that missed, and select several to approve at once.

**Why this priority**: `review_required` is the default policy, so without the review queue generated posts cannot move forward.

**Independent Test**: Seed posts in review (valid, invalid, and with a remembered `add_to_queue` policy), then exercise each action and confirm the resulting review state, scheduling, and messages, including a bulk approve where one selected post is invalid.

**Acceptance Scenarios**:

1. **Given** a valid post in review, **When** a member approves it, **Then** it becomes approved and leaves the queue; if its remembered scheduling policy is `add_to_queue`, each target is placed in its account's next free slot using the existing queue service and the resulting times are shown.
2. **Given** a post in review with blocking validation problems, **When** a member tries to approve it, **Then** approval is refused and the problems are listed next to the post.
3. **Given** a post in review, **When** a member edits a variant and chooses "Save and approve", **Then** the edit is validated; if it passes the post is approved (and queued per its remembered policy), otherwise it stays in review with the problems shown.
4. **Given** a post in review, **When** a member rejects it (optionally with a reason), **Then** it leaves the queue, is never scheduled, and is listed under "Rejected" in the post list.
5. **Given** a post in review, **When** a member regenerates it, **Then** new content replaces the old, the new generation is recorded, and the post stays in review.
6. **Given** several posts selected, **When** a member bulk approves, **Then** each valid post is approved (and queued per its policy); posts with blocking problems or that can no longer be queued are left in review; and a summary states how many were approved and lists each one skipped with its reason.
7. **Given** two members approve the same post at the same moment, **Then** it is approved once, queued at most once, and the second member is told it was already approved.
8. **Given** no posts in review, **Then** the screen says "Nothing to review" and links to Generate.
9. **Given** an approved post whose remembered policy is `add_to_queue` and one target account has no posting slots, **When** it is approved, **Then** the post is approved, the other targets are queued, and that target stays unscheduled with the message "This account has no posting slots".

---

### User Story 4 - Approval and scheduling policies, defaults and overrides (Priority: P2)

Each project has a default approval policy and a default scheduling policy. On Generate, the person sees the policies that will apply and can override them for this one request, within what their role allows. Choosing auto-approve together with add-to-queue is presented as its own clearly labelled option that says posts will be approved and put into the queue without anyone reviewing them, and it must be confirmed.

**Why this priority**: Policies decide where generated posts end up; defaults are already stored, but overrides, role limits and the forced-review rule are what make auto-approval safe.

**Independent Test**: Run the full matrix of approval policy × scheduling policy × "passes validation / fails validation" with the fake LLM and confirm each resulting review state and scheduling; then attempt overrides as each role and confirm the allowed and refused combinations are enforced on the server.

**Acceptance Scenarios**:

1. **Given** `review_required` with either scheduling policy, **When** a post is generated, **Then** it is placed in review and not scheduled.
2. **Given** `auto_approve` + `leave_as_draft` and a post that passes validation, **When** it is generated, **Then** it is approved and not scheduled.
3. **Given** `auto_approve` + `add_to_queue` and a post that passes validation, **When** it is generated, **Then** it is approved and each target is placed in its account's next free slot.
4. **Given** `auto_approve` with either scheduling policy and a post that fails platform validation (after the one retry), **When** it is generated, **Then** it is placed in review with its problems listed and is not scheduled, regardless of policy.
5. **Given** an editor, **When** they override the approval policy to `auto_approve`, **Then** the request is refused on the server with "Only owners and admins can auto-approve" and nothing is generated.
6. **Given** an editor and a project default of `auto_approve`, **When** they generate without overriding, **Then** the project default applies (it was set by an owner or admin).
7. **Given** an owner or admin, **When** they override to any combination, **Then** it applies to this request only and the project defaults are unchanged.
8. **Given** the `auto_approve` + `add_to_queue` combination selected (as an override or as the project default), **Then** the Generate screen shows it as a distinct, labelled choice with a plain explanation, the request is accepted only with an explicit confirmation, and a request that asks for the combination without the confirmation is refused on the server.
9. **Given** the project settings screen, **When** an owner or admin sets the defaults to `auto_approve` + `add_to_queue`, **Then** the same labelled explanation and confirmation are required.

---

### User Story 5 - Generate a series from one brief (Priority: P2)

An editor opens Generate → Series, writes one brief (for example "a five-day countdown to the launch"), chooses how many posts (N), the voice profile, target accounts and policies. Docket first returns a plan of N distinct angles, each with a short title and a one-line description. The editor edits, reorders, removes or adds angles, then chooses "Write posts". Docket writes one post per angle so the posts do not repeat each other, and shows them together.

**Why this priority**: Series is the second mode in scope; it reuses the single-post core plus a planning step.

**Independent Test**: With the fake LLM, request a plan for N=5, edit one angle, delete one, then write posts. Confirm 4 posts are created in plan order, each prompt includes its own angle and the titles of the other angles to avoid, all are linked to the same series, and each has its own generation metadata and the policy outcome from Story 4.

**Acceptance Scenarios**:

1. **Given** a brief and N between 2 and 10, **When** the editor asks for a plan, **Then** N angles are returned and shown for editing; nothing is saved as a post yet.
2. **Given** a plan, **When** the editor edits, reorders, removes or adds angles (keeping 1 to 10), **Then** the plan used for writing is exactly the edited one.
3. **Given** a confirmed plan, **When** the posts are written, **Then** one post per angle is created, each generated with the shared brief, its own angle, and the other angles listed as things not to repeat; the posts are grouped as one series in plan order.
4. **Given** `add_to_queue` applies, **When** series posts are approved, **Then** they take the next free slots in plan order for each account.
5. **Given** one angle's post fails to generate after its retry, **Then** the other posts are still created, the failed angle is shown with its error and a "Try again" action, and no duplicate posts are created when it is retried.
6. **Given** the planning response is unreadable after its one retry, **Then** no plan is shown, the failure is recorded, and the editor can try again.

---

### User Story 6 - Swap between OpenAI and Anthropic by configuration (Priority: P2)

A deployer sets which LLM provider and model to use and supplies that provider's key. Generation works the same with either provider; nothing in the app names a model.

**Why this priority**: The owner has an OpenAI key first (OpenAI is delivered first) but wants Anthropic as an equal option.

**Independent Test**: With a fake transport for each provider's client, run the same generation through each implementation and confirm both send the voice, inputs, image and output schema in that provider's form, both return a validated result with usage and latency, and both map timeouts, rate limits, refusals and incomplete output to the same failure kinds.

**Acceptance Scenarios**:

1. **Given** the provider is set to OpenAI with a model and an OpenAI key, **When** a post is generated, **Then** the OpenAI implementation is used with that model and the metadata records "openai" and the model name.
2. **Given** the provider is set to Anthropic with a model and an Anthropic key, **Then** the same flow works through the Anthropic implementation and the metadata records "anthropic".
3. **Given** the provider is set but the model or the matching key is missing, or the provider name is unknown, **Then** startup reports exactly which setting is missing or wrong, and generation is shown as not configured while the rest of the app runs.
4. **Given** a call exceeds the configured timeout, **Then** it fails with "The model took too long to answer" and the failure is recorded.
5. **Given** a configured real key, **When** the implementation phase runs its live check, **Then** real call latency is measured and logged; without a key the report states latency as "unmeasured".

---

### Edge Cases

- **Instagram target without media**: before generating, Generate warns that Instagram needs an image; if the person continues, the Instagram variant is generated, the post fails Instagram's validation, and it goes to review regardless of policy.
- **Platform that does not allow text-only and no image**: same as Instagram (forced review, clear problem text).
- **Account needing reconnection**: it can still be targeted; its status is shown next to it; publishing behaviour is unchanged.
- **Pasted source text containing instructions** (for example "ignore previous instructions"): source text is presented to the model as material to write about, clearly separated from instructions; the output still goes through the same validation and policy.
- **Very long inputs**: brief up to 2,000 characters, one-off instructions up to 2,000 characters, pasted source text up to 50,000 characters; longer input is refused with the limit shown, before any model call.
- **Image the model cannot accept** (unsupported format, too large): a converted or resized copy within the limits is sent; if none can be made, generation is refused before the call with a message naming the image.
- **Image not publicly reachable**: the image is sent as bytes instead of by URL.
- **Model refuses** or returns truncated output: treated as an unreadable response (one retry, then failure recorded).
- **Rate limit or provider outage**: after the SDK's own bounded retries, the request fails with a plain message; no post is saved; the failure is recorded.
- **Double submit** of Generate: one request produces one set of posts; the button is disabled while pending.
- **Voice profile edited while a generation is running**: the generation uses the version that was current when it started and records that version.
- **Voice profile with empty optional fields**: empty sections are left out of the prompt rather than sent as empty headings.
- **Per-platform guidance for a platform not targeted**: not included in the prompt.
- **Regenerate on a scheduled or published post**: not offered; the post must be unscheduled first.
- **Editing an auto-approved post** so it breaks a platform rule: the existing composer and scheduling gates still block it from being scheduled or published.
- **Project with no voice profile**: Generate shows an empty state ("No voice profile yet") with a link to create one for owners and admins and "Ask an owner or admin to create one" for editors.
- **Removed member mid-generation**: their next request is refused (existing membership checks); a call already in flight may finish, but its save is refused if the person no longer has access.
- **Cross-project**: a voice profile, post, account or media asset from another project can never be used or seen; requests naming one are treated as "not found".
- **Secrets**: API keys never appear in prompts, generation metadata, logs, error messages, the browser or test snapshots.

## Requirements *(mandatory)*

### Functional Requirements

**LLM layer**

- **FR-001**: The system MUST put all model calls behind one LLM provider interface that takes: a system prompt and user content, zero or more images (each as a public URL or as bytes with its media type), an output schema, a timeout, and a request label; and returns either the schema-validated result with usage (input and output tokens when the provider reports them), latency in milliseconds, provider name and model name, or a typed failure (`invalid_output`, `refused`, `incomplete`, `timeout`, `rate_limited`, `unavailable`, `auth`, `bad_request`).
- **FR-002**: The system MUST provide an OpenAI implementation (delivered first) and an Anthropic implementation of that interface, each using its provider's native structured-output mechanism from the research, and each re-validating the returned value against Docket's own schema, because the provider-side schema cannot express every constraint.
- **FR-003**: The provider and model MUST be chosen only by configuration: `LLM_PROVIDER` (`openai` | `anthropic`), `LLM_MODEL`, and the matching key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). No model name may appear in code or defaults. All are documented in `.env.example` and validated at startup; when the group is absent or incomplete, generation features are disabled with a clear message naming the missing settings and the rest of the app keeps working.
- **FR-004**: The system MUST provide a fake LLM implementation for tests that returns scripted responses in order, records every request it receives (prompt, images, schema name), and can simulate invalid output, refusal, truncation, timeout and rate limiting. No test may make a live LLM call.
- **FR-005**: Image inputs MUST be in a format and size both providers accept (JPEG, PNG, WebP or non-animated GIF; at most 10 MB and 8000×8000 px, R1). An image is sent by public URL when the media asset is publicly reachable, otherwise as bytes; an existing variant or a resized copy is used when the original exceeds the limits.
- **FR-006**: Each model call MUST have a timeout taken from configuration (`LLM_TIMEOUT_SECONDS`, default 90) and a bounded number of transport retries (at most 2); the total time a person waits for one generation is shown as pending on the button and ends in a result or a plain error.
- **FR-007**: Every model call MUST be logged with provider, model, request label, latency, outcome and token usage, and never with keys, full prompts or images.

**Voice profiles**

- **FR-008**: Each project MUST support any number of voice profiles. A profile has a name and versioned content: voice and tone, audience, topics and content pillars, things to avoid, example posts (zero or more), preferred links (zero or more, each a URL with an optional label), preferred hashtags (zero or more), and per-platform guidance (free text per registered platform).
- **FR-009**: Profile versions MUST be immutable. Saving an edit creates a new version numbered one higher, records who made it and when, and becomes the profile's current version. Saving from a stale version is refused with a conflict message and nothing is overwritten (Story 2 scenario 3).
- **FR-010**: Each project MUST have at most one default voice profile, set by an owner or admin; the default cannot be archived. Profiles can be archived and restored; archived profiles cannot be chosen for new generations; their versions remain readable.
- **FR-011**: Creating, editing, archiving, restoring profiles and setting the default MUST be limited to owners and admins and enforced on the server. All members can view profiles and their version history.
- **FR-012**: The voice profile screen MUST offer a "Try it" panel that generates sample variants for chosen platforms (defaulting to the platforms of the project's connected accounts) from a brief, using the profile content as shown (owners and admins: including unsaved edits; editors: a saved version), and shows counts and validation problems. Try it MUST NOT create posts, versions or generation records.

**Generation core**

- **FR-013**: The system MUST assemble each generation prompt from, in order: fixed instructions on role and output, the voice profile version's non-empty fields, per-platform guidance for targeted platforms only, each target platform's rules from its provider capabilities (text limit with its counting rule, whether media is required, whether text-only is allowed, maximum images), the one-off instructions, and the inputs (brief, then pasted source text clearly marked as source material and not instructions, then a note that images are attached). Prompt assembly MUST be checkable on its own, without making a model call.
- **FR-014**: The output schema MUST contain exactly one variant per distinct target platform, each with the post text and, where the platform supports it, alt text for each attached image; all fields required (absent values nullable), so it is valid for both providers' structured outputs.
- **FR-015**: Each variant MUST be checked with Docket's own schema and then with the platform's existing validation path (the same one the composer and scheduling gates use, including image planning). If any variant has blocking problems, or the response could not be read, the system MUST make exactly one more call that includes the previous output and the list of problems, then use that result.
- **FR-016**: If the second response is still unreadable (or refused, truncated, timed out), no post is saved and a generation failure record is saved with the request, the error kind, a plain message and the latency of each attempt; the person sees the message and a "Try again" action. If the second response is readable but still breaks platform rules, the post is saved and placed in review with the problems attached (FR-024).
- **FR-017**: Each saved post MUST have origin "generated" and generation metadata containing: the full assembled prompt (system and user parts), provider name, model name, voice profile id and version number, all inputs (brief, source text, one-off instructions, media asset ids, target account ids, series id and angle when applicable), the policies requested and applied, usage, latency per attempt, whether a retry happened and why, and the time. Regenerating appends a new entry and keeps earlier entries.
- **FR-018**: Each target's content MUST be its platform's variant, and attached media MUST be attached to the targets whose platforms allow images.
- **FR-019**: The generation core MUST be one service that the UI calls now and that generation jobs and the public API will call later; it MUST NOT depend on the UI or on how it was called.
- **FR-020**: An image-generation extension point MUST exist as an interface only (request: prompt, size or aspect hint, project; result: media asset or failure), with no implementation, no configuration and nothing in the UI.

**Modes**

- **FR-021**: Single mode MUST accept a brief (required), pasted source text (optional), one-off instructions (optional), a voice profile (default preselected), one or more target accounts in the project, optional media assets from the project's library (as many as the most permissive selected platform allows), and optional policy overrides; it returns the saved post(s) for editing on a result screen.
- **FR-022**: Generated posts MUST be editable and regenerable on the result screen while not scheduled or published. Edits go through the existing post update and validation path. Regenerate accepts an optional extra instruction, reuses the post's stored inputs and the profile's current version, replaces the content, never approves or schedules the post, and moves it to review if the new content fails validation.
- **FR-023**: Series mode MUST accept a brief, N (2–10), and the same options as single mode; first produce a plan of N angles (each a title and a one-line description) through the same LLM layer and retry rule; let the person edit, reorder, add and remove angles (1–10 kept); then write one post per angle, each prompt including its angle and the other angles to avoid repeating. Series posts are linked by a series id and ordered by angle position. One angle's failure never prevents the others; a failed angle can be retried without duplicating posts already written.

**Approval and scheduling policy**

- **FR-024**: There MUST be exactly one approval policy service that, given the approval policy, scheduling policy and the post's validation result, decides the post's review state and whether to queue it: `review_required` → in review; `auto_approve` and valid → approved; any post with blocking validation problems → in review, regardless of policy. It is used by single mode, series mode and regenerate now, and is the one generation jobs and the public API will use.
- **FR-025**: The scheduling policy MUST be remembered on each generated post. `leave_as_draft` never schedules. `add_to_queue` places each target in its account's next free slot through the existing queue service, immediately when the post is approved by policy, or when a reviewer approves it. A target whose account has no slots is left unscheduled with the existing message, without affecting other targets.
- **FR-026**: Policies MUST default to the project's defaults. A request may override either policy for itself only. The server MUST refuse an `auto_approve` override from an editor; owners and admins may choose any combination; any member who can generate may choose either scheduling policy.
- **FR-027**: The combination `auto_approve` + `add_to_queue` MUST be shown as its own labelled choice ("Approve and queue automatically — no review") with a one-sentence explanation, both on Generate and when setting project defaults, and the server MUST refuse it unless the request carries an explicit confirmation. When it is the project default, Generate shows that label prominently before the person submits.
- **FR-028**: Changing project default policies MUST remain limited to owners and admins (existing rule).

**Review queue**

- **FR-029**: The Review screen MUST list the project's posts in review, newest first, each showing its platform variants with counts, its validation problems, its voice profile name and version, its brief and its remembered scheduling policy; with pagination for more than 50.
- **FR-030**: Members MUST be able to approve, edit then approve ("Save and approve"), reject (with an optional reason), regenerate, and bulk approve selected posts. Approval is refused while blocking problems remain. Bulk approve approves each eligible post independently and reports approved and skipped posts with reasons.
- **FR-031**: Approval MUST be safe under concurrency: a post is approved and queued at most once even if approved twice at the same time; the later request is told it was already approved.
- **FR-032**: Rejected posts MUST leave the review queue, be excluded from scheduling and publishing, keep their content and generation metadata, and be listed under a "Rejected" filter in the post list.
- **FR-033**: All screens in this feature (Generate single and series, Voice list, profile editor with Try it and history, Review) MUST follow the `docket-ui` skill: keyboard usable, labelled fields, explicit loading, empty, error and populated states, status shown as text and colour, project time zone on all times.

**Isolation and security**

- **FR-034**: Voice profiles, their versions, generation failure records and series MUST be project-owned and accessed only through the scoped data-access layer; every request checks membership and role on the server.
- **FR-035**: LLM keys MUST never reach the browser, generation metadata, logs, error messages or test snapshots.

**Verification**

- **FR-036**: Tests MUST cover: prompt assembly (included and omitted sections, order, platform rules, source-text separation); structured-output validation and the single retry (invalid then valid, invalid twice, unreadable twice, refusal, timeout); the approval × scheduling × validation matrix including validation failure forcing review; role limits on overrides and on voice profile management; voice profile versioning (immutability, numbering, stale-save conflict, default and archive rules); both provider implementations against a fake transport. All LLM calls are mocked.
- **FR-037**: When a real key is configured in the environment where implementation runs, a live check MUST generate one sample post through the configured provider and record the measured latency in the phase report and `docs/decisions.md`; without a key the report states latency as "unmeasured" and the live path as "verified with mocks only".

### Key Entities

- **Voice profile**: a named, project-owned profile with a current version number, archived flag, and created/updated times. The project points to at most one default profile.
- **Voice profile version**: an immutable snapshot of a profile's content (voice and tone, audience, topics and pillars, avoid list, example posts, preferred links, preferred hashtags, per-platform guidance), its version number, author and creation time.
- **Generation record**: an entry in a post's generation metadata describing one generation: prompt, provider, model, profile version, inputs, policies requested and applied, usage, per-attempt latency, retry reason, time.
- **Generation failure**: a project-owned record of a generation that saved no post: who asked, mode, inputs, error kind, plain message, attempt latencies, time.
- **Series**: a project-owned group linking the posts written from one brief and its edited plan of angles, in order.
- **Policy decision**: the approval policy service's output for one post: review state and whether to queue, with the reason (for example "forced to review: Instagram needs an image").
- **Image generation request/result** (interface only): a future way to create a media asset from a prompt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can go from opening Generate to a saved, platform-valid post for two accounts in under 2 minutes, excluding the model's own answer time.
- **SC-002**: Every generated post can be traced to the exact prompt, provider, model, voice profile version and inputs that produced it: 100% of generated posts in tests carry complete generation metadata.
- **SC-003**: No post that fails platform validation is ever approved or queued automatically: 0 such posts across the full policy matrix tests.
- **SC-004**: When the first model answer breaks a platform rule and the second is valid, the person gets a valid post with no extra action; exactly two model calls are made, never more.
- **SC-005**: Switching between OpenAI and Anthropic requires changing configuration only; the same test scenarios pass for both implementations.
- **SC-006**: Editing a voice profile never changes what an earlier post records: 100% of earlier posts still name their original version and that version's content is unchanged.
- **SC-007**: "Try it" returns samples without creating any saved record: 0 rows written in tests.
- **SC-008**: A reviewer can clear 20 valid posts from the review queue with one bulk approve and see a summary of what was approved and what was skipped.
- **SC-009**: A series of N posts yields N posts with distinct angles (no two prompts share an angle), and a failure in one angle leaves the other N−1 posts saved.
- **SC-010**: An editor can never cause posts to skip review by override: 100% of such requests are refused on the server in tests.
- **SC-011**: Real model latency is either measured and recorded, or explicitly reported as unmeasured; never assumed.

## Assumptions

- Owners and admins manage voice profiles and project default policies; editors generate, review and schedule (from the brief's role rules).
- Generated posts go through the existing post, target, validation and queue services; this feature adds no new scheduling or publishing behaviour.
- Single mode creates one post per request (with one target per selected account); generating several alternatives at once is not in scope.
- Series size is limited to 10 in this entry because writing happens while the person waits; larger series and background processing belong to generation jobs.
- Input limits (brief 2,000, instructions 2,000, source text 50,000 characters) and the 90-second default timeout are reasonable starting values and are configurable only where stated.
- A post in review is editable and regenerable; once scheduled, regenerate is not offered.
- The "Rejected" state is added to the post review states; rejected posts are kept, not deleted.
- The existing post list gains "Needs review" and "Rejected" filters if not already present.
- Generation runs inside the person's request; there is no background processing in this entry.
- Out of scope: generation jobs, batch mode, item sources, media "used" tracking, the public API, API keys, webhooks, image generation itself, video.
