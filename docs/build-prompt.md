# Build prompt: multi-project social scheduler and post generator

> Product brief as written by the project owner (2026-10-02). Owner answers to
> the open questions are in "Owner answers" at the end and override the body.
> Platform facts were re-verified in `docs/research/`; where they disagree with
> this brief, the research wins.

## What I'm building and why

I run several projects, each with its own social accounts. I previously used Postiz (scheduling), n8n plus OpenAI (generation), and Directus (post metadata), all in separate Docker containers. It worked, but it was a lot of moving parts and did not scale across projects. I want one codebase that replaces all three.

The product has two pillars:

1. **Scheduler**: compose, queue into per-account posting slots or schedule at a time, and publish posts to Facebook Pages, Instagram, Threads, and Bluesky.
2. **Generator**: produce posts with an LLM, one at a time, as a series, or in batches, using editable per-project voice profiles and a configurable approval policy.

The most important property is that I can hop between projects quickly. Every account, post, media file, and brand setting belongs to exactly one project.

Only I and people I invite will use this, and only with accounts we own. It is not a SaaS for third parties. That matters because it means the Meta app can stay on Standard Access with our accounts added as app roles or testers, with no App Review.

Scope for now is text and images. Video comes later, so do not build it, but do not design it out (see "Publishing as a step machine").

## How to work

- Work in the phases below. At the end of each phase, report what was built, what was verified, and what could not be verified.
- Platform APIs change often. Do not rely on memory for endpoint names, parameters, scopes, limits, or library APIs. Check the official docs (and current library docs) and say when the docs disagree with this prompt. The docs win.
- Never report something as working unless you ran it. If a step needs real credentials you do not have, say so and cover it with a mocked-HTTP test instead.
- Prefer boring, well-supported choices and few dependencies. Ask before adding infrastructure beyond what is listed here.

## Stack

- Next.js (App Router), TypeScript in strict mode, Tailwind.
- Postgres. Must run against a local Postgres container and against Neon with no code changes beyond the connection string.
- Drizzle ORM with SQL migrations checked into the repo.
- Auth: **Better Auth**, not NextAuth. Email and password login. Sign-up is invite-only (see "Members and invitations").
- Media storage: any S3-compatible bucket behind a small storage interface (Cloudflare R2 or S3 in production).
- Validation with Zod at every boundary (forms, API routes, LLM output, provider responses).
- Tests with Vitest. Provider tests use mocked HTTP, never live calls.

## Deployment: one codebase, any host

The app must not depend on one hosting platform. Support these, in this order of priority:

1. **Docker Compose** (local and self-hosted): services are `web` (Next.js standalone build), `worker`, and `postgres`. One `docker compose up` gives a working app.
2. **A container host plus Neon** (Render, Fly, a VPS, or similar): the same Docker image, with the database on Neon. The scheduler runs either as a second process or service from the same image, or through the tick endpoint below.
3. ~~Netlify plus Neon~~ — dropped (see Owner answers).

The scheduler has one entry point and several triggers:

- All scheduling logic lives in one library function, `runTick()`, which does a bounded amount of work (target well under 30 seconds) and returns. It must be safe to run concurrently and safe to be killed mid-run.
- **Worker trigger**: a small process that calls `runTick()` in a loop every 30 to 60 seconds. Used by Docker Compose and by hosts with an always-on process.
- **HTTP trigger**: `POST /api/internal/tick`, authenticated with a secret from an env var, which calls `runTick()` once. Any external cron (a host's cron job, a hosted cron service, n8n) can drive the scheduler through it.
- An env var chooses whether the web process also runs the worker loop in-process, for single-service hosts.
- Show "last successful tick" in the UI and warn loudly when it is stale, because on a sleeping or misconfigured host the scheduler stops silently.

Hosting facts checked by the owner, which should shape `docs/deployment.md`: Render's free web services spin down after 15 minutes without inbound traffic, Render's free tier has no background workers or cron jobs, and Render's free Postgres expires after 30 days. So free Render only works with an external cron hitting the tick endpoint every minute, which is fragile. Write `docs/deployment.md` covering each option honestly, including that trade-off.

## Data model

Design the schema properly, but it needs at least these concepts. Every table except users carries `project_id`, and every query is scoped by it. Enforce that in one data-access layer, not ad hoc in each route.

- **projects**: name, slug, timezone, default voice profile, default approval and scheduling policies.
- **project_members** and **invitations**: see "Members and invitations".
- **social_accounts**: project, provider key, display name, external account id, credentials (encrypted), token expiry, status (`active`, `needs_reauth`), last error.
- **media_assets**: project, storage key, public URL, mime type, dimensions, byte size, alt text.
- **posts**: project, status (`draft`, `needs_review`, `approved`, `scheduled`, `publishing`, `published`, `partially_failed`, `failed`), base content, origin (`manual`, `generated`, or `api`), generation metadata.
- **post_targets**: one row per post per social account. Holds the scheduled time in UTC, how it was scheduled (`slot`, `explicit`, or `now`), the per-platform content override, the step machine state, the external post id and URL once published, attempt count, and last error. The scheduled time lives here, not on the post, because slot scheduling can give each account a different time.
- **posting_slots**: see "Posting slots and the queue".
- **voice_profiles**, **generation_jobs**, **generation_job_items**: see "Generator".
- **api_keys**: see "Public API".
- **publish_attempts**: append-only log of every provider call made for a target (step, request summary, response summary, outcome, timestamp). Never log tokens.

Encrypt credentials at rest with AES-256-GCM using a key from an env var. Tokens must never reach the browser or the logs.

## Members and invitations

Membership is per project. Someone can belong to one project without seeing the others.

- Roles: `owner`, `admin`, `editor`. Owners and admins manage members, accounts, slots, voice profiles, and API keys. Editors create, generate, review, and schedule posts. Enforce roles on the server in the data-access layer, not just in the UI.
- **Invite**: an owner or admin invites by email with a role. Invitations expire and can be revoked or regenerated.
- **Confirm or deny**: the invitee accepts or declines. An invitee without an account signs up through the invitation link, and that is the only way to sign up. A logged-in user sees their pending invitations in the app.
- **Kick**: an owner or admin removes a member. Removal takes effect immediately, including for sessions already open. A project must always keep at least one owner.
- Members can leave a project themselves. Owners can change roles and transfer ownership.
- Bootstrap: the first user is created from env vars or a one-time setup screen, and can create projects.
- Invitation delivery, for now, uses no email at all. If the invited email belongs to an existing user, they get an in-app notification with accept and decline actions. If it does not, the app generates a single-use invitation URL that the inviter copies and sends themselves, and the new user signs up through it. Keep delivery behind a small interface so email can be added later.
- Invitation URLs carry an unguessable token, stored hashed, and stop working once used, revoked, or expired.
- Keep an audit log of membership changes (who invited, removed, or changed whom, and when).

Use Better Auth's organization plugin, mapping one organization to one project, rather than building this by hand. See `docs/research/better-auth.md` for what it does and does not cover.

## The provider framework

This is the part the owner most wants done well, because platforms and post types will be added later. Adding a new provider should mean adding one folder and registering it, with no changes to the scheduler, the composer, or the database schema.

Sketch of the shape (refine it, but keep the ideas):

```ts
interface SocialProvider {
  key: string;                       // "facebook" | "instagram" | "threads" | "bluesky" | ...
  displayName: string;
  capabilities: ProviderCapabilities; // max text length and how it is counted, max images,
                                      // allowed mime types, max bytes, whether media is required,
                                      // whether text-only is allowed, supported post types
  connect: ConnectStrategy;           // OAuth redirect flow, or a credential form (Bluesky)
  refreshCredentials?(account): Promise<Credentials>;
  validate(content, capabilities): ValidationIssue[];
  // Step machine: do one bounded unit of work and say what happens next.
  advance(ctx: PublishContext): Promise<StepResult>;
}

type StepResult =
  | { kind: "continue"; state: unknown; notBefore?: Date }  // persist state, run again later
  | { kind: "done"; externalId: string; url?: string }
  | { kind: "retryable_error"; error: string; notBefore: Date }
  | { kind: "fatal_error"; error: string }
  | { kind: "ambiguous"; error: string };                   // may or may not have posted
```

- Post types (`text`, `image`, `carousel`, later `video`, `story`, `reel`) are declared in capabilities so the composer can show or hide options per account.
- The composer validates against capabilities live and shows per-platform previews and character counts.
- Include a `mock` provider that pretends to publish. The whole scheduler must be testable end to end with it and no real accounts.

### Publishing as a step machine

Instagram and Threads publish in two calls (create a container, then publish it), and containers can take time to become ready. Do not wait in-process. Each `advance()` call does one step, persists its state on the `post_targets` row, and returns. The next tick picks it up. This keeps every tick short and is what will make video possible later, since video containers need polling over several minutes.

### Scheduler rules

- Claim due targets with `SELECT ... FOR UPDATE SKIP LOCKED` (or an equivalent lease column) so two ticks never work the same target.
- Retry `retryable_error` with exponential backoff and a cap on attempts.
- **Never blindly retry a publish step whose outcome is unknown.** If the final publish call times out or returns something unparseable, mark the target `ambiguous` and surface it in the UI for the owner to resolve. A missed post is better than a duplicate post.
- A post with mixed outcomes across targets becomes `partially_failed`, and individual targets can be retried.
- Enforce per-account publish limits in our own code before calling the platform.
- A separate part of the tick refreshes tokens that are close to expiry and flags accounts as `needs_reauth` when refresh fails. Show that prominently in the UI.

## Posting slots and the queue

Each social account has its own weekly posting slots, and "add to queue" means "use the next free slot".

- A slot is a day of the week plus a local time, belonging to one social account. Times are in the project's timezone. An account can have any number of slots, and slots can be paused without deleting them.
- The composer offers three actions: **add to queue**, **schedule at a specific time**, and **publish now**.
- Add to queue assigns each target the next free slot for its own account. A post going to three accounts can therefore go out at three different times. Show the resulting times before confirming.
- A slot occurrence holds one post per account. Allocation must be transactional, so two posts queued at the same moment (from the UI, a generation job, or the API) can never take the same occurrence. Back this with a database constraint, not just application logic.
- Compute the UTC time from local wall time at assignment, and handle daylight saving changes correctly, including local times that do not exist or occur twice.
- If an account has no slots, add to queue fails for that target with a clear message rather than guessing a time.
- When a queued target is cancelled, deleted, or moved, its slot occurrence becomes free. Do not reshuffle other posts automatically. Provide explicit actions instead: move to next free slot, swap two queued posts, and "pull the queue forward" for one account.
- Explicitly timed posts do not consume slots, but warn if one lands close to a queued post on the same account.
- The calendar shows upcoming empty slots per account so gaps are visible, and lets the user drop a post onto one.
- Slot allocation is one service function used by the UI, generation jobs, and the API.

## Platform notes

See `docs/research/meta.md` and `docs/research/bluesky.md` for the verified versions of these notes. Make the Graph API version an env var.

**Shared Meta setup**: one Meta app for all projects. Standard Access is enough as long as every account has a role on the app. Write `docs/meta-setup.md` with the exact dashboard steps the owner must do by hand.

**Facebook Pages**
- `POST /{page-id}/feed` (and the photos edge for images) with a Page access token and `pages_manage_posts`.
- Long-lived Page tokens, derived from a long-lived user token, have no expiry date but can be invalidated.
- Use our scheduler, not Facebook's native `scheduled_publish_time`, so all platforms behave the same.
- Docs: https://developers.facebook.com/docs/pages-api/getting-started/ and https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived

**Instagram**
- Professional accounts only. Create a container at `/{ig-id}/media`, then `POST /{ig-id}/media_publish`. Carousels: one container per item, then a carousel container, up to 10 items.
- Meta fetches media from a URL, so the file must be publicly reachable at publish time.
- JPEG is the only supported image format. Convert on upload.
- 100 API-published posts per account per rolling 24 hours. Unpublished containers expire after 24 hours.
- Instagram has no text-only posts, so media is required.
- Use Facebook Login for Business (one connect flow covers a Page and its linked Instagram account) — verified, see research.
- Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing/ and https://developers.facebook.com/documentation/instagram-platform/overview

**Threads**
- Separate Threads use case with its own app ID and secret. Accounts must be added as Threads testers and accept the invite.
- Create a container at `/{threads-user-id}/threads`, then publish with `threads_publish`. Text-only posts are allowed. Media must be at a public URL.
- Short-lived tokens last 1 hour. Long-lived tokens last 60 days and can be refreshed once they are at least 24 hours old and not expired.
- Rate limit: 250 posts per 24 hours (verified).
- Docs: https://developers.facebook.com/documentation/threads/get-started

**Bluesky**
- Auth with handle plus app password via `com.atproto.server.createSession`, then `com.atproto.repo.createRecord` with an `app.bsky.feed.post` record. Support a custom PDS URL, defaulting to `https://bsky.social`.
- Text limit is 300 graphemes (count graphemes, not characters or bytes).
- Up to 4 images, uploaded with `uploadBlob`, each up to 2,000,000 bytes per the current lexicon. Compress to fit.
- Links, mentions, and hashtags are not auto-detected. Build facets with UTF-8 byte offsets. Use the official `@atproto/api` rich text helper.
- Docs: https://docs.bsky.app/docs/advanced-guides/posts and the lexicons at https://github.com/bluesky-social/atproto/tree/main/lexicons

## Media

- Upload through the app to the bucket. Store dimensions, size, and alt text. Alt text is passed to every platform that supports it.
- Generate per-platform variants as needed (JPEG for Instagram, under the byte limit for Bluesky).
- **Local development problem to solve**: Instagram and Threads cannot fetch from `localhost`, so a local MinIO container will not work for real publishing. Use a real bucket in every environment, and document that. The `mock` provider covers offline development.
- OAuth redirect URIs have the same issue. Document each platform's local redirect options. As a fallback, provide a way to paste a token generated in Meta's tools directly into the account settings.

## Generator

The generator has three ways in (single, series, batch) on top of one shared core. Everything it produces goes through the same approval policy and the same queue.

### Voice and context

- Each project has one or more **voice profiles**: voice and tone, audience, topics and content pillars, things to avoid, example posts, preferred links and hashtags, and per-platform guidance. One is the project default.
- Voice profiles are editable in the UI at any time and are versioned. Every generated post records which profile version produced it.
- Any generation can add one-off instructions on top of the profile.
- A "try it" panel on the voice profile screen generates sample posts without saving them, to tune the voice quickly.

### LLM layer

- Put the LLM behind a small interface so the provider and model are env-configured. Do not hardcode a model name.
- The interface must accept image input, because batch generation from the media library needs the model to look at each image.
- Output is structured and Zod-validated, with a separate variant per target platform that respects that platform's capabilities (length, media requirement). If output fails validation, retry once with the errors, then record the failure.
- Store the prompt, model, voice profile version, and inputs with each generated post.

### Three modes

1. **Single post**: a topic or brief, optional pasted source text, target accounts, optional media. Returns drafts that can be edited or regenerated.
2. **Series**: one brief produces N related posts (a campaign, a countdown, a set of tips). Generate a plan of distinct angles first, show it for editing, then write the posts, so they do not repeat each other.
3. **Batch (one post per item)**: replaces the old n8n loop, which pulled every available image and generated a post for each. A batch job takes a list of items and a template, and produces one post per item.

### Generation jobs

Model series and batch as **generation jobs** with **job items**, so the same framework handles both and can grow.

- A job has: an item source, a voice profile, instructions, target accounts, an approval policy, and a scheduling policy.
- Item sources sit behind an interface. Build these three now: a selection from the media library (by filter, tag, or "not yet used in a post"), an uploaded CSV where each row is an item with arbitrary columns available to the instructions, and items submitted through the API.
- Each job item is processed independently and records its own status, output post, and error. One failed item never fails the job. Failed items can be retried and a running job cancelled.
- Jobs are processed by `runTick()` using the same claim-and-advance pattern as publishing. LLM calls are slow, so process a small bounded number of items per tick. Measure real call times and report if this is too tight.
- Track which media assets have been used in posts, so "generate for all unused images" is one click and never produces duplicates.
- Show job progress in the UI (queued, running, done, failed counts) with links to the resulting posts.

### Approval policy

- Policies: `review_required` (posts land in the review queue as `needs_review`) and `auto_approve` (posts skip review).
- Scheduling policies: `leave_as_draft` or `add_to_queue` (each post takes the next free slots for its accounts).
- Each project has a default for both. A job or an API call can override them, limited by the caller's role or API key permissions.
- `auto_approve` plus `add_to_queue` means a batch can go from images to a filled calendar with no clicks. Make that combination an explicit, clearly labelled choice, and still run platform validation on every post. A post that fails validation always goes to review.
- The review queue supports approve, edit then approve, reject, regenerate, and bulk approve.

Leave a clean extension point for image generation, but do not build it.

## Public API

Everything above must be drivable over HTTP. The UI, the jobs, and the API all call the same service layer.

- Versioned REST API under `/api/v1`, authenticated with project-scoped API keys. Keys are created and revoked in project settings, stored hashed, shown once, and carry permissions (for example read, write posts, generate, auto-approve). Use Better Auth's API key plugin if it fits (see research).
- Endpoints, at minimum: upload media or register it by URL, list media (with the "unused" filter), create a post, generate a single post, create a generation job and add items to it, get job and item status, add a post to the queue, schedule at a time, list upcoming slots, get post and target status, list social accounts.
- Accept an idempotency key on every write, so a retried n8n step never creates a duplicate post.
- Optional outgoing webhooks per project, signed, for post published, post failed, job finished, and account needs reauth.
- Rate limit per key. Return consistent, documented error shapes.
- Generate an OpenAPI document from the route schemas and serve it, and add `docs/n8n.md` with a worked example that reproduces the old flow: loop over rows, call generate with an image, add to queue.

## UI

- Routes are project-scoped: `/p/[projectSlug]/...`. A project switcher is always visible and keyboard accessible, and it remembers the last project.
- Screens: calendar (month and week, in the project's timezone, showing empty slots), post list with status filters, composer, generate (single, series, batch), generation jobs, review queue, media library, accounts (connect, status, reauth, posting slots), voice profiles, members and invitations, API keys and webhooks, and a failures view showing ambiguous and failed targets with their attempt logs.
- Composer: base content, optional per-platform overrides, live validation and counts per target, media picker, then add to queue, schedule at a time, or publish now.
- Clean and fast over fancy. Server components where they fit. Full keyboard use and sensible empty and error states.

## Quality bar

- Unit tests for each provider's `validate` and `advance` using mocked HTTP, including error and ambiguous-outcome paths.
- Tests for the scheduler: concurrent ticks do not double-claim, a killed tick is recoverable, backoff works, ambiguous outcomes are not retried.
- Tests for slots: concurrent queueing never double-books an occurrence, daylight saving transitions resolve correctly, freed occurrences are reused.
- Tests for membership: role checks on the server, a removed member loses access immediately, the last owner cannot be removed, expired and revoked invitations fail.
- Tests for generation jobs: one failed item does not fail the job, retries do not duplicate posts, approval and scheduling policies are honoured, API idempotency keys work.
- A test that fails if any query touches project-owned data without a project scope, or the closest practical equivalent.
- `.env.example` documenting every variable, and startup validation that fails loudly when one is missing.
- A README covering local setup and Docker Compose, `docs/deployment.md`, plus `docs/adding-a-provider.md`.
- Lint, typecheck, and tests run in CI and pass before a phase is called done.

## Phases

1. **Foundation**: repo, Docker Compose, database and migrations, Better Auth, projects, members and invitations with roles, project switcher, scoped data-access layer.
2. **Scheduler core**: posts, targets, media library, composer, calendar, posting slots and the queue, `runTick()` with the worker and HTTP triggers, the `mock` provider. End-to-end scheduling works with the mock.
3. **Bluesky**: the simplest real provider, to prove the framework.
4. **Meta**: Facebook Pages, then Instagram, then Threads, with connect flows, token refresh, and `docs/meta-setup.md`.
5. **Generator**: voice profiles, single and series generation, review queue, approval policies.
6. **Batch and API**: generation jobs with item sources, the public API, API keys, webhooks, `docs/n8n.md`.
7. **Hardening**: failures view, limits, docs, deployment walkthroughs.

## Out of scope for now

Video, stories and reels, analytics, comment or inbox management, other platforms, billing, public sign-up, Netlify.

## Owner answers (2026-10-02)

1. **LLM providers**: implement both OpenAI and Anthropic behind the interface. OpenAI first (the owner has an OpenAI key first). Model names come from env.
2. **Repo**: `jamiebclark/docket`, public and open source (MIT) — others may deploy it for themselves, so docs must not assume the owner's infrastructure.
3. **Roadmap**: run all entries back to back; auto-merge to `main` is allowed when CI is green and review is clean.
4. **Scope enforcement**: no Postgres row-level security; the DAL + lint rule + scope test is enough.
5. **Netlify**: skipped. Deploy locally first, then on an Unraid server via Docker Compose.
6. **Node**: Node 24 LTS (Temporal via `@js-temporal/polyfill`).
7. **Threads local OAuth**: hosts-file hostname + mkcert certificate (Meta's sample-app approach), not a tunnel.
8. **Process**: conventional commits; small logical commits with explicit paths (no `git add -A`); semantic-release.
