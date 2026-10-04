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

## Out of scope

Background jobs, batch mode, a public API, and image generation. Generation runs inside the request.
