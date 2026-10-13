# Generator

The generator turns a brief (plus optional source text, instructions and an image) into posts for the project's accounts, using a voice profile and the rules of each target platform. Everything it saves goes through the same review and scheduling paths as hand-written posts.

## Configuring a provider

Generation is off until `LLM_PROVIDER` is set. The rest of Docket works without it; startup logs the problem and carries on.

| Variable | Meaning |
| --- | --- |
| `LLM_PROVIDER` | `openai` or `anthropic` |
| `LLM_MODEL` | A model id your account can use. There is no default on purpose. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | The key for the chosen provider only |
| `LLM_TIMEOUT_SECONDS` | 10–600, default 90 |
| `LLM_MAX_OUTPUT_TOKENS` | 256–32000, default 4000 |

The environment variables above set the install's own credential. A project may also store its own provider, model and key, in which case that project's calls spend its own credential instead of the install's — see "Per-project provider, model and key" below. Whichever credential a call resolves to, the key is read only to make that call: it is never stored in plaintext outside its encrypted column, logged or rendered. To check a configuration against the live API, run `pnpm llm:check`; it prints `provider=… model=… outcome=… latency_ms=…`; a billing refusal prints `outcome=credit_exhausted`. Add `--project <slug>` to check a specific project's resolved credential (install default or its own) instead of the install's.

**Billing refusals.** If the provider refuses a call because the account has no spendable credit or quota left, that is not a lasting failure: generation for that credential pauses, and resumes on its own the moment a call succeeds again — nobody needs to retry anything or restart Docket. While paused, the runner still lets exactly one call through every 5 minutes as a probe, so recovery is noticed quickly without hammering the provider. Nothing is failed, cancelled or unreserved while paused: queued items simply wait. The only thing to do is add credit (or quota) to the provider account; every other generation path (single, series, regenerate, "Try it" and `pnpm llm:check`) is unaffected and answers immediately with the same honest message.

## Per-project provider, model and key

Under a project's **Settings → Model**, an owner or admin may set that project's own provider, model and API key, so the project spends its own credential instead of the install's. An editor does not see this sub-nav item at all, and the URL 404s for them (absent, not disabled). Setting, changing or removing the credential is audited (actor, provider and model before and after, never the key), and the key itself is write-only: the field is never pre-filled, no screen, log or error message ever renders a fragment of it, and the status shown is only "a key is stored" or "no key is stored", plus who last changed it and when.

**Resolution.** A call for a project uses that project's own credential if one is stored (`provider` set), otherwise the install's. Leaving a project's provider unset is exactly the "use the install default" state; nothing elsewhere in the product needs to know which credential a given call used. The call's timeout and max-output-token limits are always the install's (`LLM_TIMEOUT_SECONDS`, `LLM_MAX_OUTPUT_TOKENS`) — a project credential does not change operational limits tied to the shared worker's tick budget.

Leaving the key field blank when saving keeps the stored key, so the model can be changed without re-entering a key nobody can read back; blank is only accepted when the provider is unchanged. Removing the override is a confirmed, explicit action: it deletes the stored key and moves the project's spend back onto the install's account immediately.

**The check.** The same "Model" page (and `pnpm llm:check --project <slug>` on the command line) makes one bounded live call through the project's resolved credential, exactly like the install-wide check, and never prints or renders any part of the key. It is serialised per project with a short cooldown, so it cannot be used to loop live calls against an account.

**The undecryptable case.** If a stored key can no longer be decrypted (for example, `CREDENTIALS_ENCRYPTION_KEY` was rotated), generation is unavailable for that project — it never silently falls back to spending the install's credit. The project is told, in a fixed sentence, that an owner or admin must re-enter the key; nothing stored is destroyed by this.

An install that only ever uses environment variables needs to do nothing: with no project credential stored, every project keeps using the install default exactly as before, and the only visible change is a settings section saying so.

## Usage

Under a project's **Settings → Usage**, an owner or admin reads what their project has used: calls, input and output tokens, a per-model and per-purpose breakdown, and the split between the install's credential and the project's own, for a chosen period (last 30 days, this month, last month or all time, in the project's own time zone). An editor does not see this sub-nav item at all, and the URL 404s for them (absent, not disabled, the same rule as "Model & API key"). The screen is complete and useful with no rate configured anywhere: calls and tokens are recorded for every call that reaches a provider, whatever its outcome, and a call with no reported counts is shown as a call with its tokens excluded from the sums, never coerced to zero.

**A row's `ok` means the provider answered, not that Docket accepted the output.** A call whose output then failed Docket's own platform checks still reads `ok` on the ledger — the ledger is a record of what the provider did, not of what got used.

**Pricing is optional and entirely the operator's.** Docket ships no prices and never fetches any. Setting `LLM_RATES` (and `LLM_RATE_CURRENCY`) in the install's environment adds a money figure to the Usage screen for the models it names — an **estimated upper bound**, never "spend", "cost", "charged" or "billed", because the provider may have charged less, or nothing at all, and the provider's own dashboard is the only record of what was actually billed. A model with no configured rate keeps showing its calls and tokens with a "no rate configured" marker, and any total on the screen names what it leaves out rather than silently dropping or zeroing it. Malformed rate configuration is non-fatal: a problem is logged by name and reason at startup and the money figure is simply unavailable for the affected model.

A batch job's page and a generated post's "Generation details" each show that job's or that attempt's own calls and tokens beside the counts and latency already there — no money figure on either, by design, so a surprising total can always be traced back to the generation that caused it.

## Policies

Each project has a default approval policy (`review_required` or `auto_approve`) and scheduling policy (`leave_as_draft` or `add_to_queue`). A generation request can override either one.

| Approval | Scheduling | Result |
| --- | --- | --- |
| `review_required` | any | Saved as `needs_review`; the scheduling policy is applied when a reviewer approves |
| `auto_approve` | `leave_as_draft` | Approved, left as a draft |
| `auto_approve` | `add_to_queue` | Approved and queued (needs the unreviewed-queue confirmation) |

A post that still fails platform validation after the one retry is always placed in review with its problems listed. Editors may only override toward review; choosing `auto_approve` as an override needs owner or admin.

## Voice profiles

A voice profile holds how the brand sounds. Every edit creates a new version; posts record the version they were generated with, so earlier posts keep naming their original version. Old versions can be read under the profile's history, and a profile can be archived. "Try it" on the voice screen runs a sample generation without saving a post, for the accounts you pick (it uses their saved posting instructions).

## Brand context

Under a project's **Settings**, an owner or admin may set a tagline (one line), a description (a
paragraph) and a website — what the brand *is*, as distinct from how it sounds (the voice) or what it is
promoting this month (a voice profile's preferred links). An editor sees the three fields, disabled. Any
field left blank is simply absent; none is required, and all three can be left unset.

Every generation entry point — single, regenerate, voice "Try it", a batch job item and a series plan —
composes a labelled `BRAND` section from whichever fields are set, before `VOICE`. A project with no
brand fields set gets exactly the prompt it got before this feature: no header, no blank lines, no
placeholder. The brand is read current at generation time; it is not versioned and not snapshotted onto a
post, unlike the voice profile a post records or the posting instructions a job snapshots at creation.
Setting, changing or clearing any field is written to the project's activity log with the previous and
new value, one row per changed field.

## Posting instructions

Tactical, per-channel advice (hashtag use and placement, links, how a post opens) lives on each **social account**, not in the voice. Owners and admins edit it under **Accounts**, in the account's block just above its posting slots; editors see it read-only. It is optional and limited to 2,000 characters. Every change is written to the project's activity log with the previous and new text.

**Prompt order.** The system message is: role and output rules, then `BRAND` (see "Brand context" above, when any field is set), then the voice, then `POSTING INSTRUCTIONS`, then each platform's `PLATFORM RULES`. The one-off instructions and inputs follow in the user message. Posting instructions never override the output rules or platform rules, and neither does the brand. The `POSTING INSTRUCTIONS` section is left out when no target account has instructions and every platform has one group, so such a request produces exactly the prompt it did before this feature. The brand's website is the link to use when a post needs one; a voice profile's `preferredLinks` is a separate, unrelated set of links to promote and stays in `VOICE` — the brand is what the project *is*, preferred links are what it is promoting right now.

**Grouping.** The model writes one variant per *group* of target accounts: accounts on the same platform whose instructions are identical (after normalising line endings and trimming; an exact, case-sensitive comparison, and "no instructions" equals "no instructions"). With one account per platform, or several with identical instructions, the keys are the platform keys and behaviour is unchanged. When a platform has two or more groups the keys are numbered by first appearance (`bluesky_1`, `bluesky_2`). Each target gets its group's text; the result and Review screens show one editable text per group, and an edit changes only that group's targets.

**Group limit.** One generation can write at most 16 groups. Over the limit the request is refused before any model call (nothing is saved), with a message telling the person to choose fewer accounts or give same-platform accounts the same instructions. The forms show a live group count. The number 16 is the strictest documented Anthropic structured-output limit and is unverified against the real API (see `docs/decisions.md`, 011).

**Snapshots.** Accounts are not versioned, so each post's generation metadata records, per account, the instructions that were used and its group. A job snapshots every target account's instructions when it is created (like the pinned voice version): editing an account mid-job changes nothing in that job, including retries and appended items. Jobs created before this feature have no snapshot and use the accounts' current instructions. Regenerating a post uses the accounts' current instructions.

**Migration.** On upgrade, each project's default voice profile's latest per-platform guidance is copied onto that project's matching accounts whose instructions are empty (no audit entries). Afterwards the voice editor no longer has platform guidance, new voice versions do not store it, and the prompt never reads it. Old versions still show it read-only in history, labelled "no longer used".

## Review queue

Posts waiting for a decision appear under Review. Reviewers can approve (singly or in bulk), edit, or reject. Rejected posts leave the queue, are never scheduled, and stay visible under the Rejected filter in Posts.

## Jobs

A job generates one post per item, in the background, so a person can hand the generator many images or spreadsheet rows at once. Start one from **Media** (select images, then "Generate posts") or from **Batch jobs → New batch job from CSV**. The Batch jobs screens show live progress, per-item failures, retry and cancel.

- **Sources.** Media items (pick images, use the current filter, or all unused images) and CSV rows. Each item's fields fill `{{placeholders}}` in the instructions; the values reach the model as marked data, not as instructions.
- **Runner.** The worker's tick claims due items, runs each with one bounded model call, and saves the post through the same save helper and policies as single posts. A correction retry that cannot fit in the tick is deferred to a later tick without counting an attempt.
- **Throughput.** At the defaults (worker interval 60 s, `GENERATION_TICK_MAX_ITEMS=2`) about **120 items an hour**, so a 500-item job takes about 4 hours. Raise `GENERATION_TICK_MAX_ITEMS` (1–10) to go faster, within your provider's rate limits. Claims rotate across jobs, so a large job does not starve a small one.
- **Limits.** 500 items per job; CSV up to 1 MB, UTF-8, 500 data rows, 50,000 characters per row; instructions up to 2,000 characters; 3 automatic attempts for temporary failures (backoff 60 s growing to 15 min). Lasting failures (refused, invalid output, deleted image) are not retried automatically.
- **Billing refusals.** An item refused on billing is not failed and no attempt is counted: it goes straight back to the queue, waiting, with a notice on both Batch jobs screens naming billing as the cause, whether it is the project's own credential or the install's, and saying since when. The runner claims nothing else for that credential — the install's, or one project's own — until a probe call (one every 5 minutes) succeeds again for it, at which point every waiting item on that credential resumes with no retry needed; a hold on the install's credential or on one project's own credential never affects any other project's items. Saving, changing or removing a project's credential clears that project's hold at once, so a key just fixed does not wait out a probe interval. Cancelling a held job, or pressing "Retry failed items", both work exactly as they do otherwise.
- **Tick budget.** A call needs at least 8 s plus a 3 s save reserve. If `SCHEDULER_TICK_BUDGET_SECONDS` is below 11, no item can start; startup logs it and the Batch jobs screen says so.
- **Slot order.** Under "add to queue", slots follow claim order, but two items finishing in the same tick can swap slots.
- **Template fields.** Media items expose `{{alt_text}}`, `{{tags}}` (comma-separated) and `{{filename}}`. CSV items expose one field per column header.
- **CSV rules.** The first line is the header. Headers must be non-empty and unique (ignoring case and spaces) and use letters, numbers, spaces, `-` or `_`. Every problem is reported with its file line number ("row" means the line in the file, header = line 1). CSV items are text-only: they attach no image.
- **Used images.** A filter selection skips images already used in a post unless "Include images already used in posts" is ticked; the job page says how many were left out. Images in a running job are reserved, so two jobs never generate for the same image.
- **Retry.** Only failed items can be retried; a retry resets the item's attempt count. Retrying never creates a second post for an item.
- **Skipped items.** An API-sourced item tagged with an `externalId` that another submission has already posted (for the same record, from this job or elsewhere) finishes **Skipped**: a neutral, non-failure state with no retry action. The job page's Detail column names the record and links to the post already made for it; a job that finishes with only skips and done items is `completed`, not `completed_with_failures`. See `docs/n8n.md` § 9 for the API side.
- **Cancel.** Cancelling discards work still in flight, releases reserved images and is final (a cancelled job cannot be resumed). Items that had already saved their post keep it, in review, and are marked done.
- **Policies** are authorised once, when the job is created, against the creator's role. The same approval and scheduling rules as single posts then apply to every item; a post that fails validation always goes to review.
- **Series** stay in-request (not jobs).
- **Measuring.** `pnpm llm:check` prints `job_call` lines and a `jobs budget_ms=…` line with a key; without one it prints `latency: unmeasured; live path verified with mocks only`. `fits=no` means a typical call is too slow for the tick budget. Measured against the live API on 2026-10-12 with `LLM_MODEL=gpt-5.4-mini`: about **1.3 s** a call (1.1 s image, 1.5 s text), **58 input / 42 output tokens** on a trivial prompt, and `fits=yes` for both call kinds against the default 17 s window — so the batch runner is not latency-bound on this model. `pnpm llm:check -- --project <slug>` runs the same check on one project's resolved credential and prints `source=project` or `source=install`, which is the quickest way to tell which credential a project is actually spending.
- **Usage.** A job's own page shows its calls and input/output token totals, labelled "to date" while it is still running, with no money figure under any rate configuration — see "Usage" above for where rates are set and what they mean.

## Out of scope

A public API (the public-api roadmap entry) and image generation. Single and series generation run inside the request; jobs run in the background.
