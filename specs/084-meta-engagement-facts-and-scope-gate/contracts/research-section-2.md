# Contract: the required shape of `docs/research/engagement.md` §2

**Feature**: `084-meta-engagement-facts-and-scope-gate` | Satisfies FR-001 to FR-010, SC-001 to SC-003

This is a contract on a **document**, because the document is this entry's interface to the two
reader entries behind it. No code reads it. A later spec phase does, and it must be able to tell a
sourced answer from a guess at a glance.

## 1. The grid

Nine questions × **four** surfaces. The surfaces are separate columns (or separate sections, if a
table that wide reads badly — either is acceptable, both are not):

1. Facebook Page comments
2. Instagram comments
3. Threads **replies**
4. Threads **mentions**

Threads mentions is a surface in its own right. Its answers are never merged into, inherited from, or
inferred from Threads replies, and the two may legitimately disagree — one confirmed, one not
(FR-001, spec Edge Cases).

The nine questions, in this order. Seven are already written in today's §2 and keep their wording;
two are new (FR-003):

| # | Question | New? |
|---|---|---|
| 1 | How are inbound items read (endpoint)? | — |
| 2 | Which permission does the read require, **and** is that permission inside the access level a self-hosted Docket install can actually obtain? | — |
| 3 | What identity fields does a commenter carry (display name, handle, identifier, profile link)? | — |
| 4 | Is that identifier stable across two comments by the same person? | — |
| 5 | Can a reply be sent at the access level the read required? | — |
| 6 | How are results paginated? | — |
| 7 | What are the read rate limits? | — |
| 8 | How does a deleted or edited comment present itself on a later read — in terms the `upstream: "withdrawn" \| "edited"` signal on `InboundItemDraft` can carry? | **yes** |
| 9 | Are comments listable per account, or only per post? | **yes** |

Question 5's answer is **recorded and not built**: sending a reply to any Meta surface is out of scope
for the whole roadmap, and no reply scope is declared or requested anywhere (FR-015).

Today's 7×3 table is **replaced**, not patched and not left alongside the new one (FR-001, US1
scenario 1). A cell-by-cell edit would silently drop the fourth surface and both new questions.

## 2. What a cell must contain

**Answered cell** — all four of:

| Field | Rule |
|---|---|
| answer | the fact, in Docket's own words, specific enough to act on |
| source | a URL on an official Meta documentation domain (`developers.facebook.com`, `developers.instagram.com`, `developers.threads.net` and the like). A third-party blog, Stack Overflow answer or aggregator is **never** proof, even when it is right (FR-004) |
| checked | `YYYY-MM-DD`, the date the source was consulted |
| evidence | `page` or `search-summary` — see §3 |

**`unverified` cell** — the literal word `unverified`, plus **what was tried**: which queries, which
domains, which pages were reached and what they did or did not say. A blank cell, a dash, or
`unverified` with no attempt recorded all fail (FR-005, SC-003).

**Never**: a plausible-sounding guess, a fact recalled without a source, or a value inferred from a
different surface. If a scope name, endpoint path, field name, pagination shape or rate limit does not
appear in a sourced cell, it may not appear in code, in configuration or in published documentation
anywhere in this entry (FR-010, SC-010).

## 3. The evidence grade, and why it exists

This pipeline has `WebSearch` and **no** `WebFetch` ([research.md](../research.md) §1 records the
probe). A search result that quotes an official page is better evidence than memory and worse than the
page itself, and constitution I does not let that difference go unrecorded.

| Grade | Means | Admissible when |
|---|---|---|
| `page` | the official page's own text was read | the tool that read it exists — record it if a later run has one |
| `search-summary` | an official-domain search result quoted the fact | the returned text states the fact **verbatim**: an endpoint path, a permission string, a field name, or a number. The official URL the quote came from is the `source` |

A result that merely gestures at a topic ("Instagram supports comment moderation") is **not**
evidence. The cell stays `unverified` and the attempt is recorded as what was tried.

Searches are domain-constrained (`allowed_domains: ["developers.facebook.com", …]`) so a third-party
page cannot be mistaken for the source.

## 4. The consequence line, per surface

Each surface closes with its own one-paragraph consequence, drawn only from its own answers (FR-006):

- **buildable** — a later entry can build this surface; name the endpoint and permission it will need;
- **must ship declared-but-`unavailable`** — and the specific reason, one of:
  - the permission is confirmed but **outside the access level** a self-hosted install can obtain
    (an answer, not a gap — the spec's second edge case);
  - the endpoint is unconfirmed;
  - the identity shape is unconfirmed;
  - something else, stated.

This is the paragraph the next two entries' spec phases read first, so it says plainly which of the
four surfaces they are allowed to build.

## 5. Conventions borrowed from `docs/research/meta.md` (FR-007)

- a `Checked YYYY-MM-DD` line at the top of the file, updated;
- a source URL per table or per section, not only per fact;
- `**UNVERIFIED**` / `unverified` rows written out explicitly rather than omitted;
- `Changed YYYY-MM-DD: was X` under any line whose fact changed;
- a closing **Code impact** note naming the files a confirmed fact affects — for this entry that is
  `src/providers/meta/connect-group.ts` and `src/providers/threads/connect-group.ts` and nothing else,
  since no reader exists yet.

## 6. The two places that point at §2

- **`docs/research/meta.md`** gains a one-line cross-reference saying comment-read facts live in
  `docs/research/engagement.md` §2, so a reader searching the Meta research file finds them; its
  `Checked` date is updated only if the file was otherwise touched (FR-009, US1 scenario 6). §2 is
  **not** moved — 077's spec, this roadmap and `docs/engagement.md` all already point at it.
- **The "Phase 9 human task" note** at the end of `docs/research/engagement.md` is **rewritten, not
  deleted** (FR-008). It must distinguish, after this entry:
  - which questions this documentation pass settled, and at which evidence grade;
  - which genuinely still need a live session, a second person to comment and a browser — and for
    those, that they are **not** required for this entry to ship (FR-005);
  - that T083/T084 remain unachievable by a headless pipeline, which is why §2 was empty, so the
    record of *why* survives.

## 7. How this is checked

Reading, not running — there is nothing to execute. The acceptance test is US1's Independent Test:
open §2 with no code running and confirm four surfaces, nine questions, a source URL + check date +
evidence grade on every answered cell, "what was tried" on every `unverified` one, Threads replies and
mentions answered separately, one consequence paragraph per surface, and the old 7×3 table gone.

A grep-based guard is deliberately **not** added: a regex over prose would pass on a well-formatted
guess and fail on an honest cell, and this repo has been bitten by audit regexes that silently matched
nothing.
