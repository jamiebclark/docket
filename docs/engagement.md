# Replying to comments and messages

The **Inbox** shows comments, mentions and replies that land on your connected accounts, and lets a
member draft and send a reply. Nothing is ever sent without a person approving it first.

## Supported platforms

| Platform | Reading comments/mentions | Replying | Direct messages |
|---|---|---|---|
| Bluesky | Yes — replies and mentions | Yes | Not yet |
| Facebook Pages | Yes — comments on the Page's own posts | Not yet — Meta has no confirmed reply-to-comment endpoint at this access level | Not yet |
| Instagram | Yes — comments on the account's own posts | Not yet — same reason as Facebook | Not yet |
| Threads | Not yet — would need `threads_manage_replies` (replies) and `threads_manage_mentions` (mentions), two independent permissions | Not yet | Not yet |

Bluesky is supported because the facts the inbox needs — how a comment identifies who posted it, how a
reply addresses its parent, and the write cost of sending one — are all confirmed from the installed
Bluesky library and Docket's own Bluesky research (see `docs/research/engagement.md`). Facebook Page and
Instagram comments are supported for reading only: the permission, the endpoint and the commenter
identity shape are all confirmed (`docs/research/engagement.md` §2), but no reply-to-comment endpoint is
confirmed at this access level on either surface, so a Facebook or Instagram comment in the inbox shows no
reply composer — it can only be dismissed or marked handled. Threads is not built yet for the same reason
insights Facebook/Instagram once were: the commenter/mention identity shape is not confirmed. Direct
messages are specified but not built on any platform — no platform's message facts are confirmed yet.

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
text, bounded to a stated length. It also carries the commenter's display name or handle, so the
reply can address them by name, but nothing else about them — no identifier, no URL, no platform
internals go to the model.

## Retention and deletion

Inbound items are kept for 90 days by default (an operator can change this), after which they are
deleted along with any reply drafted for them — unless a draft is still waiting for a decision, or a
send attempt is stuck in an unresolved state, in which case the item is kept until that is resolved. An
item a provider explicitly reports as deleted or edited upstream is marked as such and, if withdrawn,
removed on the next retention pass regardless of its age. Bluesky does not yet carry this signal — how
a deleted or edited reply presents itself on a later read is unverified (`docs/research/engagement.md`),
so no Bluesky item is ever auto-withdrawn today; the path is exercised through the mock provider only.
The record of what was actually sent is never deleted, so a reply is never sent twice even after the
item it answered is gone.

Disconnecting an account leaves its items readable but stops drafting and sending; reconnecting makes
them sendable again. Removing an account from a project, or deleting the project, deletes its
engagement data outright.

## Platform permissions

Each supported surface needs only the access it already has for publishing:

- **Bluesky**: the same app-password session used for publishing is used to read notifications and
  send replies. No extra permission is requested.
- **Facebook Pages and Instagram**: opt in with `META_ENGAGEMENT_SCOPES=true` so the connect dialog also
  asks for `pages_read_user_content` (Facebook) and `instagram_manage_comments` (Instagram) —
  `pages_read_engagement` is already requested by every connection, but it alone is not enough: it does
  not cover comments other people leave. If your Meta app uses a login configuration
  (`META_LOGIN_CONFIG_ID`), the permission must be added to that configuration in the Meta dashboard
  instead — the flag alone cannot widen it there. See [meta-setup.md](meta-setup.md#engagement). A
  missing permission never affects publishing. An account connected before the flag was turned on, or
  whose last grant did not include the new permission, is skipped by the read with "Inbox needs a
  reconnect" on the Accounts page; reconnecting grants it without touching the account's ability to
  publish.
- **Threads**: opt in with `THREADS_ENGAGEMENT_SCOPES=true` so the connect dialog also asks for
  `threads_manage_replies` and `threads_manage_mentions`. See
  [meta-setup.md](meta-setup.md#engagement). A missing permission never affects publishing; nothing is
  read on either surface yet regardless of this flag (`docs/research/engagement.md` §2).

## What this does not do yet

- **No comment moderation** — the inbox cannot hide, delete or report a comment on the platform, only
  reply to it or mark it dismissed inside Docket.
- **No public API or MCP surface** — reading the inbox and sending replies is only available from the
  Docket web app signed in as a member; no API key or MCP tool can reach it.
- **No webhooks** — a new comment or reply does not trigger an outgoing webhook.
- **Direct messages are pending research** — specified, modelled, and visually distinct (marked
  Private) wherever the mock provider exercises them in tests, but not read, drafted or sent on any
  real platform until a platform's message facts are confirmed.
