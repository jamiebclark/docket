# Onboarding a new brand

What it takes to go from "we have a new product" to "Docket is posting for it", and in what order.
Written while onboarding Up Next (October 2026); re-check the platform steps against
[meta-setup.md](meta-setup.md) before relying on them.

## The one thing to get right: start the accounts first

The copy takes an afternoon. The accounts take days, because Meta gates each step on the one
before it and some of those steps are reviews you wait on. So **begin the account chain on day
one and write the copy while it bakes** — not the other way round.

```
Facebook Page
  └─> Instagram account
        └─> switch it to Professional (Business or Creator)
              └─> link it to the Page
                    └─> Threads profile (created from Instagram)
                          └─> invite as Threads Tester on the Meta app
                                └─> accept the invite inside Threads

Bluesky  (independent of all of the above, about three minutes)
```

Two places this bites:

- **Instagram must be a professional account linked to a Page**, or it never appears in Docket's
  chooser. See [meta-setup.md §4](meta-setup.md#4-app-roles).
- **That link needs a business portfolio to exist first.** Without one, Meta's "Connect account"
  dialog runs to its last step and its Continue button silently does nothing — no error, no
  message, in both Facebook Settings and Meta Business Suite. Granting someone Facebook access to
  the Page creates a portfolio, after which the same button works first time. If that dialog
  hangs, this is why.
- **Threads only connects for accounts invited as a Threads Tester**, and the invite has to be
  accepted from inside Threads. Without it you get error 1349245. See
  [meta-setup.md § Threads: testers](meta-setup.md#threads-testers).

Bluesky needs no app and no review, so connect it first and get something publishing while Meta
catches up.

## What Docket does and does not hold

Docket is a posting tool, not a brand system. It has **no fields for a logo, a tagline or a
website**. The natural "brand kit" list maps onto it like this:

| Brand asset | Where it actually goes |
|---|---|
| Name | `projects.name` |
| URL name (slug) | `projects.slug` — see the collision note below |
| Time zone | `projects.timezone` |
| Logo | **Each platform's avatar only.** Media is post attachments, not a brand avatar |
| One-sentence description | **Each platform's bio only.** Docket has no field for it |
| Longer description | Voice profile → *Audience* and *Topics and pillars* |
| Website URL | Voice profile → *Links*, and each account's posting instructions |
| Per-platform tactics | Each account's **posting instructions**, not the voice profile |

Keep the brand kit in a file next to the product, not in your head, and treat it as the source
of truth that the platform profiles and the Docket project are both copied from.

> **Slugs are unique across the whole install, not per tenant.** `projects.slug` carries a global
> unique constraint, so another tenant's project can hold the slug you want and all you see is
> "That URL name is already taken" — the project itself 404s. Have a second choice ready; the
> product's domain usually makes a good one.

## Runbook

### 1. Write the brand kit first

One file per brand. It needs the name, slug, time zone, the website, a one-sentence description,
a few longer sentences, and the voice-profile fields. Measure every bio against the real limit
before you paste it anywhere — see [Profile limits](#profile-limits).

> **Instagram's website field cannot be set on desktop** — it is disabled with "Editing your links
> is only available on mobile." Until it is set in the phone app there is no clickable link on the
> profile at all, so keep the bare domain as a line in the bio. Threads has a working Links field
> on web and needs no such workaround.

### 2. Prepare the avatar

Every platform crops the avatar to a circle. Render the circle crop and look at it before
deciding you need a padded variant; a square app-icon style logo usually survives, with the
corners trimming like a vignette.

Bluesky is the constraint: its lexicon caps avatars at **1,000,000 bytes** and accepts only
`image/png` and `image/jpeg`. A 1024 px PNG commonly lands near 1.7 MB and is rejected, so export
a JPEG for Bluesky and keep the PNG for the rest.

### 3. Start the account chain

Follow the diagram above. Bluesky first so something is connectable the same day.

### 4. Create the Docket project

**Project → Create project**: name, URL name, time zone. Nothing else is asked and nothing else
can be set here.

### 5. Create the voice profile

**Brand voice → New voice profile.** Four free-text fields of 2,000 characters each (*Voice and
tone*, *Audience*, *Topics and pillars*, *Avoid*), plus links and hashtags. The first profile in a
project automatically becomes the default.

Keep brand voice here and platform tactics out of it — per-platform guidance moved onto accounts.

### 6. Connect each account, then set its posting instructions and slots

Both live on the **Accounts** screen, per account. Posting instructions are where "no link in the
Instagram caption" and "300 graphemes on Bluesky" belong.

### 7. Set the project defaults

**Settings** → approval policy and scheduling policy. Decide deliberately whether generated posts
go to Review or are auto-approved.

## Profile limits

Confirmed October 2026. Re-check before trusting them.

| Platform | Field | Limit |
|---|---|---|
| Instagram | Bio | 150 characters |
| Threads | Bio | 150 characters. Threads has its **own** bio and its own Links field — only the profile photo is imported from Instagram |
| Bluesky | Display name | 64 graphemes |
| Bluesky | Description | 256 graphemes |
| Bluesky | Avatar | 1,000,000 bytes; `image/png` or `image/jpeg` only |
| Facebook Page | Bio (short) | 101 characters |
| Facebook Page | About | 255 characters |

Bluesky's figures come from `lexicons/app/bsky/actor/profile.json` in `bluesky-social/atproto`.
The others are from platform help pages and are worth re-confirming in the UI as you paste.

Bluesky handles can be set to a domain you own (`playupnext.live` instead of
`name.bsky.social`) with a DNS TXT record, which is worth doing at creation time rather than later.

## What cannot be scripted today

The public API (`/api/v1`) is post-centric. It can list accounts and create posts, media and jobs,
but there is **no endpoint that creates a project, a voice profile, a posting slot or an account's
posting instructions**. Every step in the runbook above is browser-only.

So onboarding a brand is currently a manual pass through the UI, with the brand-kit file as the
thing that makes it repeatable rather than re-decided.

**If brand onboarding becomes routine, the gap to close is write access to project setup**:
`POST /projects`, `POST /voice-profiles`, `PATCH /accounts/{id}` for posting instructions, and
`POST /slots`. With those, a brand kit could be applied in one command and the whole runbook
below step 3 would collapse into it. Nothing else in the chain is automatable — the account
creation is human-gated by design.
