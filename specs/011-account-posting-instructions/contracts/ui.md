# Contract: UI

All screens follow the `docket-ui` skill:

- server components by default, with client components only at the leaves;
- visible labels, with help text through `aria-describedby`;
- errors next to the field and announced, with focus moved to the first invalid field;
- one right-aligned primary action that shows its own pending state;
- text-plus-colour badges;
- keyboard-only flows.

Before writing any route or action code, read `node_modules/next/dist/docs/01-app/` (Next.js 16.3.8, see AGENTS.md).

## Accounts: posting instructions (FR-002, FR-003)

**Where**: `src/app/p/[projectSlug]/accounts/page.tsx`, inside each account's `<section>`, directly before the `Posting slots` heading.

**Server part (page)**: it renders an `<h3>Posting instructions</h3>` and then:

- for owners and admins (`canManage`): `<PostingInstructionsForm slug accountId accountName initial={account.postingInstructions} />`;
- for editors: the text in a `whitespace-pre-wrap` block, or "No posting instructions." There is no edit control.

**Client part**: `accounts/PostingInstructionsForm.tsx` (new). It contains:

- `<label for>`: "Posting instructions for {accountName}".
- `<textarea rows=5>` described by:
  - **help text**: "How posts for this account are written: for example where hashtags go and how many, whether to include the link and where, how a post opens. The brand voice still applies.";
  - **counter**: `{n} / 2,000`, where `n` is the normalised text's `.length`, the same unit the server checks. Past 2,000 it switches to the error colour and the text "{n} / 2,000, too long";
  - **error**: rendered next to the field with `aria-live="polite"`. Focus moves to the textarea on a failed save.
- **Save button** (primary, right-aligned): it shows "Saving…" while pending and is disabled only while pending.
- **On success**: a `LiveRegion` message, "Saved." when changed, or "No changes." when the text was the same.

**Server action**: `setPostingInstructionsAction(slug, { accountId, instructions })` in `accounts/actions.ts`. It wraps `runAction(slug, scope => accounts.setPostingInstructions(scope, accountId, { instructions }))`. A Zod failure reaches the field as `fieldErrors.instructions`.

## Members: activity (FR-004)

- `settings/members/activity-list.tsx`: `LABEL.account_posting_instructions_update = "changed the posting instructions for"`.
- `settings/members/page.tsx`: `detailSubject` also matches `account_posting_instructions_update` and shows `"{details.displayName}"`.

## Voice editor and history (FR-024, FR-025)

- **Editor**: `voice/VoiceEditor.tsx` and `voice/voice-logic.ts` drop the platform-guidance fieldset and the `platformGuidance` form field. Under the hashtags field the editor shows a one-line note: "Rules for a single channel (hashtags, links, how a post opens) now live in each account's posting instructions," linking to `/p/{slug}/accounts`.
- **History**: `voice/[profileId]/history/page.tsx` shows `<Show label="Platform guidance (no longer used)">` only when the old version's `platformGuidance` is non-empty. Under it: "Docket no longer uses this. Each account's posting instructions replace it. Edit them on Accounts", linking to Accounts. The section stays read-only.

## Try it panel (FR-020, FR-013)

- **Account choice**: in `voice/TryItPanel.tsx`, an "Accounts" fieldset replaces the "Platforms" fieldset. It has one checkbox per account, labelled "{displayName} ({providerName})" and grouped by platform as on Generate.
  - The default selection is `defaultTryItSelection(accounts)` from `src/lib/generation/groups.ts`, the same function the service uses. It is not re-implemented in the panel.
  - **Server refusal**: a server refusal (for example after instructions changed while the page was open) shows `result.message` as the panel error. For the group limit that is the full `groupLimitMessage(n)` (research D5).
  - The live group-limit message sits under the fieldset (`role="status"`, `aria-live="polite"`) when the selection exceeds 16 groups.
- **Props**: `platforms` and `defaults` are replaced by `accounts: AccountOption[]`.
- **No accounts**: the panel shows the `EmptyState`: "Connect an account to try this voice. Go to Accounts" (a link).
- **Samples**: one card per returned variant. Its heading is "{providerName}: {accountNames.join(', ')}", followed by the text, `used / limit` and the issues. "Samples are not saved." stays.

## Generate (single and series) and job forms (FR-013)

- **`AccountOption`** (`generate/generate-logic.ts`) gains `postingInstructions: string | null`. It is filled in `generate/page.tsx`, `jobs/new/form-data.ts` and the voice page, from `AccountView.postingInstructions`.
- **Live group-limit message**: `generate/GenerateForm.tsx` and `jobs/new/JobForm.tsx` (also used by the CSV job form) compute `groupTargets(selected).length`. Past 16, they show `groupLimitMessage(n)` under the account fieldset (`role="status"`, `aria-live="polite"`) before submit.
  - Submit stays enabled ("disable only while pending"). The server refuses with the same message.
    - The form shows it next to the account picker from `result.fieldErrors.targetAccountIds`, which `failFromError` fills from `GroupLimitError` (see [services.md](./services.md) § Errors).
    - The form-level error is `result.message`, the same text. A form may skip the banner when the field error already shows it, but it must not show the generic "Some posts have validation problems.".
  - **Regenerate** (`generate/result/[postId]/RegenerateDialog.tsx`): it has no live count, because the groups come from the post's current accounts. A refusal shows `result.message`, that is the full group-limit text naming the count, the maximum and the fix, as the dialog error.
- **Account hint**: the account fieldset's hint gains: "Accounts on the same platform with different posting instructions each get their own version."

## Result screen and Review (FR-011, FR-015)

- **Result screen**: `generate/result/[postId]/page.tsx` builds its cards from `variantGroupsForPost`.
  - `VariantCard` gains `key` and `instructions`.
  - The card heading is "{providerName}: {accountNames}".
  - Under "Generation details", a "Posting instructions used" list shows each account's name, platform and the instructions used: "None", or "Not recorded" for older records.
- **`VariantEditor`**: it sends `edits: cards.map(c => ({ accountIds: c.accountIds, text: <edited text> }))`. The `used / limit` counts come from the existing check route per card (first account), unchanged.
  - **Keying**: all client state is keyed by the card's group `key`: the edited-text map, the controlled `<textarea>` value, the counts and the issues. It is never keyed by `providerKey`, because two cards can share one.
  - **Pure helper**: the card + edited-texts → `{ key, text }[]` display and `{ accountIds, text }[]` edits mapping lives in `variant-logic.ts` and is unit-tested. Editing `bluesky_2` changes only that card's text and its edit (research D13).
- **Review**: `review/ReviewList.tsx` renders one entry per `ReviewVariant` (now per group), with the same heading. Its approve-with-edits sends `{ accountIds, text }`.
- **Remaining problems**: shown as `{label}: {message}`. The label is `p.label ?? p.groupKey ?? p.providerKey` from the record's `remainingProblems`, the same expression `POST /api/v1/generate` uses (D7, D13). A bare group key such as `bluesky_2` is never shown on its own.

## Job page (FR-016)

`jobs/[jobId]/page.tsx` adds a "Posting instructions (as of job creation)" list in the job settings. For each target it shows:

- "{displayName} ({platform})" followed by the text, "None", or, for pre-feature jobs, "Not recorded: uses each account's current instructions";
- removed accounts as "Removed account", as today.

## States

- No new route is added, so there are no new `loading.tsx` or `error.tsx` files.
- The new client components handle the pending, error and success states listed above.
- The Try it panel adds the empty state described above.
