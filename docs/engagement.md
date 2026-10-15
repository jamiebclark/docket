# Replying to comments and messages

The **Inbox** shows comments, mentions and replies that land on your connected accounts, and lets a
member draft and send a reply. Nothing is ever sent without a person approving it first.

## Supported platforms

| Platform | Reading comments/mentions | Replying | Direct messages |
|---|---|---|---|
| Bluesky | Yes — replies and mentions | Yes | Not yet |
| Facebook Pages | Not yet | Not yet | Not yet |
| Instagram | Not yet | Not yet | Not yet |
| Threads | Not yet | Not yet | Not yet |

Bluesky is supported because the facts the inbox needs — how a comment identifies who posted it, how a
reply addresses its parent, and the write cost of sending one — are all confirmed from the installed
Bluesky library and Docket's own Bluesky research (see `docs/research/engagement.md`). The same
questions for Facebook Pages, Instagram and Threads are still unverified, so no Meta surface is built
yet: nothing here will show a commenter's name or identifier unless it traces to a confirmed answer.
Direct messages are specified but not built on any platform, for the same reason — no platform's
message facts are confirmed yet.

## Nothing sends without a person

A reply only reaches the platform after a member reviews it on the **Review** page (or the inbox item
itself) and presses Approve. This holds even when the project's auto-approve setting is on for regular
posts — that setting is never read on the reply path. An approved reply is sent by the next scheduler
run, not instantly, so it can wait its turn behind scheduled posts and the account's own write limits.

## Who may read and who may reply

Project owners, admins and editors can read the inbox and send replies. No other role, no API key and
no automation (including the scheduler's own job-running identity) can read or reply — there is no way
to grant an API key or the public API this permission, and no MCP tool mentions it. A member who cannot
read the inbox never sees the inbox link, its unread count, or a direct link to `/inbox`.

## What drafting costs

Asking for a drafted reply spends against the project's own AI usage, the same ledger and credit
checks that post generation uses, under a separate line item (`engagement.reply`) so engagement spend
is visible apart from post generation on the Usage page. Writing a reply by hand, with no draft
requested, costs nothing.

The draft prompt carries the project's voice profile, the brand's tagline and description, the
account's own posting instructions, the brand's own earlier post when it is known, and the comment's
text, bounded to a stated length. It never carries the commenter's name, handle or any other identity
field — only the comment's text goes to the model.

## Retention and deletion

Inbound items are kept for 90 days by default (an operator can change this), after which they are
deleted along with any reply drafted for them — unless a draft is still waiting for a decision, or a
send attempt is stuck in an unresolved state, in which case the item is kept until that is resolved. An
item the platform reports as deleted is removed on the next pass regardless of its age. The record of
what was actually sent is never deleted, so a reply is never sent twice even after the item it answered
is gone.

Disconnecting an account leaves its items readable but stops drafting and sending; reconnecting makes
them sendable again. Removing an account from a project, or deleting the project, deletes its
engagement data outright.

## Platform permissions

Each supported surface needs only the access it already has for publishing:

- **Bluesky**: the same app-password session used for publishing is used to read notifications and
  send replies. No extra permission is requested.

## What this does not do yet

- **No comment moderation** — the inbox cannot hide, delete or report a comment on the platform, only
  reply to it or mark it dismissed inside Docket.
- **No public API or MCP surface** — reading the inbox and sending replies is only available from the
  Docket web app signed in as a member; no API key or MCP tool can reach it.
- **No webhooks** — a new comment or reply does not trigger an outgoing webhook.
- **Direct messages are pending research** — specified, modelled, and visually distinct (marked
  Private) wherever the mock provider exercises them in tests, but not read, drafted or sent on any
  real platform until a platform's message facts are confirmed.
