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

Keys are read from the environment only and never stored, logged or rendered. To check a configuration against the live API, run `pnpm llm:check`; it prints `provider=… model=… outcome=… latency_ms=…`.

## Policies

Each project has a default approval policy (`review_required` or `auto_approve`) and scheduling policy (`leave_as_draft` or `add_to_queue`). A generation request can override either one.

| Approval | Scheduling | Result |
| --- | --- | --- |
| `review_required` | any | Saved as `needs_review`; the scheduling policy is applied when a reviewer approves |
| `auto_approve` | `leave_as_draft` | Approved, left as a draft |
| `auto_approve` | `add_to_queue` | Approved and queued (needs the unreviewed-queue confirmation) |

A post that still fails platform validation after the one retry is always placed in review with its problems listed. Editors may only override toward review; choosing `auto_approve` as an override needs owner or admin.

## Voice profiles

A voice profile holds the guidance the model is given. Every edit creates a new version; posts record the version they were generated with, so earlier posts keep naming their original version. Old versions can be read under the profile's history, and a profile can be archived. "Try it" on the voice screen runs a sample generation without saving a post.

## Review queue

Posts waiting for a decision appear under Review. Reviewers can approve (singly or in bulk), edit, or reject. Rejected posts leave the queue, are never scheduled, and stay visible under the Rejected filter in Posts.

## Jobs

A job generates one post per item, in the background, so a person can hand the generator many images or spreadsheet rows at once. Start one from **Media** (select images, then "Generate posts") or from **Jobs → New job** (upload a CSV). The Jobs screens show live progress, per-item failures, retry and cancel.

- **Sources.** Media items (pick images, use the current filter, or all unused images) and CSV rows. Each item's fields fill `{{placeholders}}` in the instructions; the values reach the model as marked data, not as instructions.
- **Runner.** The worker's tick claims due items, runs each with one bounded model call, and saves the post through the same save helper and policies as single posts. A correction retry that cannot fit in the tick is deferred to a later tick without counting an attempt.
- **Throughput.** At the defaults (worker interval 60 s, `GENERATION_TICK_MAX_ITEMS=2`) about **120 items an hour**, so a 500-item job takes about 4 hours. Raise `GENERATION_TICK_MAX_ITEMS` (1–10) to go faster, within your provider's rate limits. Claims rotate across jobs, so a large job does not starve a small one.
- **Limits.** 500 items per job; CSV up to 1 MB, UTF-8, 500 data rows, 50,000 characters per row; instructions up to 2,000 characters; 3 automatic attempts for temporary failures (backoff 60 s growing to 15 min). Lasting failures (refused, invalid output, deleted image) are not retried automatically.
- **Tick budget.** A call needs at least 8 s plus a 3 s save reserve. If `SCHEDULER_TICK_BUDGET_SECONDS` is below 11, no item can start; startup logs it and the Jobs screen says so.
- **Slot order.** Under "add to queue", slots follow claim order, but two items finishing in the same tick can swap slots.
- **Template fields.** Media items expose `{{alt_text}}`, `{{tags}}` (comma-separated) and `{{filename}}`. CSV items expose one field per column header.
- **CSV rules.** The first line is the header. Headers must be non-empty and unique (ignoring case and spaces) and use letters, numbers, spaces, `-` or `_`. Every problem is reported with its file line number ("row" means the line in the file, header = line 1). CSV items are text-only: they attach no image.
- **Used images.** A filter selection skips images already used in a post unless "Include images already used in posts" is ticked; the job page says how many were left out. Images in a running job are reserved, so two jobs never generate for the same image.
- **Retry.** Only failed items can be retried; a retry resets the item's attempt count. Retrying never creates a second post for an item.
- **Cancel.** Cancelling discards work still in flight, releases reserved images and is final (a cancelled job cannot be resumed). Items that had already saved their post keep it, in review, and are marked done.
- **Policies** are authorised once, when the job is created, against the creator's role. The same approval and scheduling rules as single posts then apply to every item; a post that fails validation always goes to review.
- **Series** stay in-request (not jobs).
- **Measuring.** `pnpm llm:check` prints `job_call` lines and a `jobs budget_ms=…` line with a key; without one it prints `latency: unmeasured; live path verified with mocks only`. `fits=no` means a typical call is too slow for the tick budget.

## Out of scope

A public API (the public-api roadmap entry) and image generation. Single and series generation run inside the request; jobs run in the background.
