# Contract: screens and server actions

Follows the `docket-ui` skill and the 003 UI contract:

- server components by default, and leaf-level client components;
- server actions return `ActionResult<T>` through `runAction(slug, fn)`;
- every view has loading, empty, error and populated states;
- times use `LocalTime` in the project zone;
- statuses use `StatusBadge` (text and colour).

The components in `src/components/ui/` are reused: `Button`, `Field`, `Select`, `Dialog`, `EmptyState`, `FilterTabs`, `Pagination`, `Table`, `LiveRegion`, `Badge`, `StatusBadge`, `LocalTime`, `MediaPicker`.

## Navigation

The `generate`, `review` and `voice` entries already exist in `LeftNav`. Their placeholder entries are removed from `[section]/page.tsx`; `jobs` stays a placeholder. The Review nav label shows a count badge, as `Review (3)`, when posts are waiting (text, not colour alone).

## Routes

| Route | Server component | Client leaves | States |
|---|---|---|---|
| `/p/[slug]/generate?mode=single` (default) | `generate/page.tsx`: voice profiles (non-archived, default preselected), accounts with status, project default policies, `getLlmStatus()`, recent failures | `GenerateForm` (mode tabs as links), `PolicyPicker`, `MediaPicker` | not configured (names the settings); no voice profile (owner/admin: "No voice profile yet. Create one"; editor: "Ask an owner or admin to create one"); no accounts ("Connect an account first", linking to Accounts); populated |
| `/p/[slug]/generate?mode=series` | same page | `SeriesPlanEditor` (plan → edit → start) | same, plus "Planning…" while pending |
| `/p/[slug]/generate/result/[postId]` | the post with its generation record, live checks | `VariantEditor` per platform, `RegenerateDialog` | not found; populated; scheduled/published (regenerate hidden, note "Unschedule to regenerate") |
| `/p/[slug]/generate/series/[seriesId]` | `getSeries` | `SeriesWriter` (writes positions in order, then shows each post or its failure with "Try again") | in progress; done; partial failures |
| `/p/[slug]/review?page=n` | `listReviewQueue` | `ReviewList` (select boxes, bulk bar, per-item actions), `VariantEditor`, `RejectDialog`, `RegenerateDialog` | empty ("Nothing to review", linking to Generate); populated; paginated over 50 |
| `/p/[slug]/voice` | `listVoiceProfiles` (+ archived under a filter link `?archived=1`) | — | empty (owner/admin: "No voice profiles yet. Create a profile"; editor: an explanation); populated table: name, default badge, current version, updated time, actions |
| `/p/[slug]/voice/new` | owner/admin only (else not found) | `VoiceEditor` | — |
| `/p/[slug]/voice/[profileId]` | `getVoiceProfile` | `VoiceEditor` (read-only for editors), `TryItPanel` | not found; archived banner with Restore (owner/admin) |
| `/p/[slug]/voice/[profileId]/history?v=n` | `listVersions`, `getVersion` | — | table of versions (number, author, time); a selected version shown read-only |

Each route gets a `loading.tsx` skeleton and uses the existing project `error.tsx`.

## Generate form (single)

Fields in this order, each with a `<label>`, help text through `aria-describedby`, and errors announced:

1. **Voice profile** (`Select`), default preselected.
2. **Brief** (textarea, required, counter `n / 2,000`).
3. **Source text** (textarea, optional, `<details>` "Add source text", counter `n / 50,000`).
4. **Instructions for this post** (textarea, optional, `n / 2,000`).
5. **Accounts** (`<fieldset>` of checkboxes grouped by platform, each with its status badge; "Needs reconnecting" accounts can be selected, per the edge case).
6. **Images** (`MediaPicker`, limited to the most permissive selected platform's `maxImages`). When an Instagram account, or any account whose platform needs media, is selected and no image is chosen, an inline warning reads "Instagram needs an image. Without one, the Instagram version will go to review." It does not block.
7. **Policies** (`PolicyPicker`, a `<fieldset>`):
   - Approval radio: "Use project default (…)" / "Review required" / "Approve automatically". Editors see "Approve automatically" disabled, with the help text "Only owners and admins can auto-approve".
   - Scheduling radio: default / "Leave as draft" / "Add to queue".
   - When the effective pair is auto + queue, the two radios collapse into one highlighted option, **"Approve and queue automatically — no review"**, with the explanation "Posts that pass every platform check will be approved and put in each account's next free slot without anyone reviewing them. Posts with problems still go to review." and a required checkbox, "I understand these posts will be queued without review" (sent as `confirmUnreviewedQueue`).
   - When this pair is the project default, the label appears at the top of the form before submit (FR-027).
8. The primary button **Generate** is right-aligned. It shows "Generating…" and is disabled while pending, and carries a hidden `requestId` (UUID made when the form mounts, renewed after a completed request).

On success the page navigates to `generate/result/[postId]`. On a model failure, an inline error box shows the plain message and a **Try again** button that resubmits with a new `requestId`.

## Variant editor

There is one card per platform: platform name, accounts it goes to, a textarea, `used / limit` from `compose/check` (debounced at 300 ms, the existing route), and an issue list (errors in red with an "Error:" text prefix, warnings in amber).

| Action | Who | Effect |
|---|---|---|
| **Save** | edit | Calls `updatePostVariants`, which updates `override_text` on all targets of the provider through `updatePost` |
| **Save and approve** | review screen only | Calls `approvePost` with edits |
| **Regenerate…** | edit | Opens a dialog with an optional "Extra instruction" field (≤ 2,000) and the primary button **Regenerate** |

A result screen also shows the policy decision as text, for example "In review: Forced to review: Instagram needs an image" or "Approved and queued: Bluesky Tue 9:00 (Europe/London)". It shows the generation details in a `<details>` element: provider, model, voice profile name and version, latency per attempt, and retried yes/no with the reason.

## Review list

The page header reads "Review" with a count. Items are newest first. Each item shows:

- its variants (read-only text, counts, issues);
- the voice profile name and version;
- the brief (truncated to 200 characters with a `title`);
- the remembered scheduling policy, as text ("Will be queued on approval" / "Stays a draft on approval");
- its created time.

Per-item actions, in a `Menu`:

- **Approve** (disabled with a reason when it has blocking problems);
- **Edit** (expands the `VariantEditor` with **Save and approve**);
- **Regenerate…**;
- **Reject…**: a dialog naming the post's first 60 characters, with an optional reason (≤ 500), using destructive secondary styling.

Bulk actions:

- Each item has a checkbox labelled "Select post: {excerpt}", and a header "Select all on this page".
- A sticky bulk bar shows "{n} selected", **Approve selected** and Clear.
- After bulk approve, a `LiveRegion` summary reads "Approved 18. Skipped 2:" followed by a list of the skipped posts with reasons.

Keyboard behaviour:

- The list is a set of `<article>` elements with headings.
- Checkboxes and menus are reachable by Tab.
- No drag interactions.

## Voice editor

`<form>` with these fieldsets:

- **Basics**: name.
- **Voice**: voice and tone, audience, topics and content pillars, things to avoid.
- **Examples**: a repeatable textarea list with Add/Remove buttons, ≤ 10.
- **Links**: repeatable URL plus label, ≤ 20.
- **Hashtags**: one text input, space- or comma-separated, normalised on blur.
- **Platform guidance**: one textarea per registered provider, labelled with its display name.

Header actions:

- **Save** (primary): it sends `baseVersion` and returns "Saved as version N". On conflict, a banner reads "This profile changed since you opened it" with "View version N" and "Reload". Nothing is lost: the form keeps the typed values.
- **Make default** and **Archive** (secondary; Archive is a confirm dialog naming the profile) and **History**.
- Editors see the same layout read-only, without these buttons. The server refuses those actions anyway.

## Try it panel

On the profile page, beside or below the editor:

- **Platforms**: checkboxes, defaulting to the providers of connected accounts.
- **Brief**: required.
- The button **Try it** shows "Trying…" while pending.
- Results are one card per platform with text, `used / limit` and issues, plus the latency.
- A caption reads "Samples are not saved."
- For owners and admins it sends the current form state (`draft`); for editors it sends the saved current `versionId`.

## Server actions (`"use server"`)

| File | Action | Service | Notes |
|---|---|---|---|
| `generate/actions.ts` | `generateSingleAction(slug, input)` | `generateSingle` | returns `GenerateResult` |
| | `planSeriesAction(slug, input)` | `planSeries` | |
| | `startSeriesAction(slug, input)` | `startSeries` | redirects to the series page on success |
| | `writeSeriesPostAction(slug, seriesId, position)` | `writeSeriesPost` | called by `SeriesWriter` sequentially |
| | `regenerateAction(slug, postId, input)` | `regeneratePost` | |
| | `updatePostVariantsAction(slug, postId, { edits })` | `updatePost` (targets by provider) | |
| `review/actions.ts` | `approveAction`, `rejectAction`, `bulkApproveAction` | review service | each `revalidatePath(/p/[slug]/review)` |
| `voice/actions.ts` | `createVoiceAction`, `saveVoiceAction`, `setDefaultVoiceAction`, `archiveVoiceAction`, `restoreVoiceAction`, `tryVoiceAction` | voice service | |
| `settings/actions.ts` (changed) | `updateProjectSettings` | `updateSettings` | passes `confirmUnreviewedQueue` from the new checkbox |

`tests/integration/actions-authz.test.ts` gains one row per new action × role (owner, admin, editor, non-member → `not_found`). In particular:

- an editor calling `saveVoiceAction` gets `forbidden`;
- an editor calling `generateSingleAction` with `approval: "auto_approve"` gets `forbidden` with the message "Only owners and admins can auto-approve".

## Settings form (changed)

When both selects are set to `auto_approve` + `add_to_queue`, the form shows the same labelled explanation and the required checkbox before Save (Story 4 scenario 9). The server refuses without it.

## Posts list (changed)

The `FilterTabs` gain **Needs review** (already a status) and **Rejected**. `StatusBadge` gains `rejected` (neutral grey, text "Rejected").
