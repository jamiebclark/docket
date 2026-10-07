# Failures and retrying

A post fails on one account at a time. The **Failures** page (and the post's own page) lists every target that failed or whose outcome is unknown, with the reason the platform gave.

## Retrying a failed target

**Retry…** opens a dialog with three choices. "Now" is preselected, so retrying immediately is open, then confirm.

| Mode | What happens |
|---|---|
| **Now** | The post is attempted again straight away, exactly as before. Content and account checks happen when it runs. |
| **Next free slot** | The dialog shows the account's next free posting slot. Confirming queues the post there like any slotted post and holds that slot. |
| **Pick a time** | You choose a date and time (shown in your time zone, with daylight-saving gaps and repeats called out). The time must be in the future. |

"Next free slot" and "Pick a time" check the post's content and the account first, and refuse a post that cannot go out. A slot the failed target already holds counts as free for it, so it is not pushed past its own slot. After a requeue it holds only the new slot.

## When there is no free slot

If the account has no free posting slot (or no active slots), nothing is rescheduled. The target stays failed and its message becomes, for example:

> Not retried — Studio Page has no free posting slot. Retry now or pick a time.

The original failure stays readable in the attempt history.

## Attempt history

Every retry writes one `retry_requested` entry recording who retried and how. "Now" has no extra detail. "Next free slot" records the mode, the new time and the slot. "Pick a time" records the mode and the time. A refused requeue records the reason (`no_free_slot`). Refusals that change nothing (a past time, invalid content, an unavailable account, a post that is no longer failed) write no entry.

## When Retry is unavailable

Retry is disabled, with the reason shown, when:

- the account was removed,
- the account needs to be reconnected,
- the account's provider is no longer available, or
- you do not have permission to schedule posts in the project.

If someone else retries or resolves the target while your dialog is open, confirming reports "This post is no longer failed." instead of scheduling a second attempt.
