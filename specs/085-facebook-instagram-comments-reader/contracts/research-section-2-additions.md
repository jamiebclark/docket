# Contract: what FR-001 to FR-005 must add to `docs/research/engagement.md` §2

**Feature**: `085-facebook-instagram-comments-reader` | Satisfies FR-001 to FR-007, SC-008

A contract on a document, for the same reason 084's was: no code reads §2, but every endpoint,
permission, field name, pagination shape and limit this feature's code uses must trace to it
(FR-007), and a reviewer must be able to tell a sourced answer from a guess at a glance.

084 built §2's shape — nine questions × four surfaces, each cell carrying an answer, a source URL, a
check date and an `evidence` grade of `page` or `search-summary`. **That shape is kept.** This entry
patches cells and adds one question; it does not rewrite the section.

## 1. Scope of the edit

**Only the two surfaces this feature ships**: Facebook Page comments and Instagram comments. The two
Threads sections are left exactly as they are — they belong to the
`threads-replies-and-mentions-reader` entry, and touching them here would make this feature's merge
the place a Threads fact got decided without a Threads reader to test it (spec Out of Scope).

## 2. Cells to replace

Six cells, three per surface. Each must carry all four of answer, source, checked date and evidence
grade; each currently reads `unverified` with what was tried.

| Surface | # | Question | Must now say |
|---|---|---|---|
| Facebook Page comments | 3 | Commenter identity fields | `from` → `{name, id}`, available **because Docket reads with a Page access token**; no handle field and no profile-link field documented |
| Facebook Page comments | 4 | Identifier stable across two comments? | Yes within one app and one Page — the scope Docket uses |
| Facebook Page comments | 8 | Deleted/edited presentation | Deletion: **absence is not a signal** — the edge's own `total_count` caveat makes absence ambiguous between privacy and deletion. Edits: still `unverified` |
| Instagram comments | 3 | Commenter identity fields | `username` for all commenters; `user` **only** when the requester owns the comment. No display name, no identifier and no profile link for someone else's comment |
| Instagram comments | 4 | Identifier stable across two comments? | **No identifier is returned at all** for a comment Docket does not own, so there is nothing to be stable. A username is not an identity |
| Instagram comments | 8 | Deleted/edited presentation | Deletion: absence is not a signal, same reasoning. Edits: still `unverified`. The existing `hidden` note stays — it is a moderation flag the media owner sets, not an upstream signal |

The exact answers, sources, dates and grades are in [research.md](../research.md) §1 (G1, G2, G3) and
are to be transcribed, not re-derived. **Transcribed, not paraphrased**: a cell that loses the
Page-token condition on Facebook's `from`, or the ownership condition on Instagram's `user`, has lost
the part that makes the answer actionable.

## 3. Cell to correct

| Surface | # | Question | Correction |
|---|---|---|---|
| Facebook Page comments | 2 | Permission, and is it inside reach of a self-hosted install? | `pages_read_engagement` **and `pages_read_user_content`**. The second is the one that permits reading *user-generated* content — the comments other people leave. Both Standard Access, by the general rule `docs/research/meta.md` already quotes |

This is a **correction to a confirmed cell**, and it must be visible as one. §2 recorded
`pages_read_engagement` alone; a reader who acted on that would have shipped a Facebook reader that
returns nothing. See [research.md](../research.md) §1.1 for the source and the consequence.

The `Consequence` paragraph under each of the two surfaces must also change: both currently read
"must ship declared-but-`unavailable`". Both now read **readable**, with the FR-006 table from
research.md §1 reproduced so the verdict is visibly mechanical rather than asserted.

## 4. The new question

§2 gains a **tenth** question, asked of all four surfaces (FR-004):

| # | Question |
|---|---|
| 10 | How does an installation list the brand's **own recent posts** on this surface — which edge, what identifier shape does it return, and what is its pagination shape? |

Asked of all four, because the grid's value is that every surface answers every question. The two
Threads rows are filled with `unverified` **plus what was tried**, which for this entry is honest and
short: nothing was tried, because no Threads read endpoint is confirmed under Q1, so there is no
listing shape to look for. A row saying that is better than a missing column.

| Surface | Must say |
|---|---|
| Facebook Page comments | `GET /{page-id}/posts` — "shows only the posts that were published by this page". **Not** `/feed`, which also returns posts others published on the Page. Returns `{page-id}_{post-id}` ids — the same shape Docket's publish path records. General Graph cursor paging |
| Instagram comments | `GET /{ig-user-id}/media` — "gets all IG Media on an IG User". Returns `ig-media-id`s, which is what `/{ig-media-id}/comments` takes. General Graph cursor paging, plus documented `since`/`until` |
| Threads replies | `unverified` — no read endpoint confirmed under Q1, so no listing shape to classify |
| Threads mentions | `unverified` — same |

Sources, dates and grades: [research.md](../research.md) §1 G4.

## 5. One more fact §2 must record, because the design rests on it

Field expansion with `.limit()` and per-edge nested paging cursors — the reason one Graph call reads
five posts *with* their comments instead of six calls reading them separately
([research.md](../research.md) §1.3, [meta-engagement-sweep.md](./meta-engagement-sweep.md) §3).

§2 half-records it already, inside Instagram's Q6 ("not included unless you use field expansion to
request the `replies` field"). It needs stating once in its own right, with its own source, because
FR-007 means a design may not depend on a fact that only appears as an aside about a different field.
A short prose note under the two surfaces' tables is enough; it does not need a question of its own.

## 6. The Phase 9 note

§2's closing section records 077's T083/T084 as unachievable headless, and lists what documentation
could not settle. Four of its bullets are now settled for two of the four surfaces, and the note must
say so rather than being left to contradict the tables above it:

- **Keep** every statement about Threads replies and Threads mentions. Nothing here changes them.
- **Narrow** the "commenter/replier/mentioner identity fields, for all four surfaces" bullet and the
  identifier-stability bullet to the two Threads surfaces, naming this entry (085) and its date as
  what settled the Meta two.
- **Keep** the read-rate-limit bullet in full. This entry confirmed nothing new there; the general
  business-use-case ceiling is still the only budget, and the design observes it rather than needing
  a number (§2 Q7).
- **Keep** the "needs a live session" framing for what remains. Edits on both Meta surfaces are still
  `unverified`, and the live verification this feature does not do is still not done.

## 7. What FR-048 adds after the code is written

FR-048 asks for anything the implementation learned that documentation alone did not give, recorded
**as an assumption rather than as a confirmed fact**. Planning already knows of three that will
qualify, and the implement phase must add any others it meets:

1. **Default ordering of both listings, and of Instagram's comments edge, is undocumented.** The
   sweep is built not to depend on it (it filters by each item's own timestamp), and the mocked tests
   fix an order that the platform has not promised. Recorded as an assumption, with the mitigation
   named.
2. **Instagram's `user`-returned-only-when-owned rule is the self-comment discriminator, and the
   word "owns" is ambiguous** between owning the comment and owning the media. The design does not
   rely on resolving it — the username comparison is the primary check — but the ambiguity is a fact
   about the documentation and belongs in §2.
3. **Nested paging cursors inside a field expansion are documented in general terms, not for the
   comments edge specifically.** The drain step exists partly because of this: if a nested cursor is
   absent where the design expects one, the busy post is simply not queued and its extra comments
   wait for the catch-up.

## 8. What must not happen

- **No fact may be written from memory.** Every cell this entry touches carries a URL on an official
  Meta domain, a date and a grade. A cell whose grade is `search-summary` must quote the official
  page's own words (084's `contracts/research-section-2.md` §3), not a summary of them.
- **No surface may inherit another's answer.** Instagram's identity row is genuinely different from
  Facebook's — one has an identifier and the other does not — and the two `Consequence` paragraphs
  must be independently reasoned (FR-006).
- **An answer that does not come must stay `unverified` with what was tried** (FR-005). Edits are the
  live case: both surfaces stay `unverified` on Q8's edit half, and the design sets `upstream` on
  neither.
- **No code change may precede this edit.** FR-001 says "before any reading code is written". The
  task order in `tasks.md` must make the §2 edit a prerequisite of the first reader task, so a
  reviewer can see that the facts came first.
