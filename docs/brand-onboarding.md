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

Docket holds the brand's words but not its pictures: a project carries a tagline, a longer
description and a website, and the generator reads them. It has **no logo or avatar field** —
that lives on each platform. The natural "brand kit" list maps onto it like this:

| Brand asset | Where it actually goes |
|---|---|
| Name | `projects.name` |
| URL name (slug) | `projects.slug` — see the collision note below |
| Time zone | `projects.timezone` |
| Logo | **Each platform's avatar only.** Media is post attachments, not a brand avatar |
| One-sentence description | `projects.tagline` (Settings → Brand), and each platform's bio |
| Longer description | `projects.description` (Settings → Brand), and each platform's About |
| Website URL | `projects.websiteUrl` (Settings → Brand), and each platform's link field |
| Per-platform tactics | Each account's **posting instructions**, not the voice profile |

Keep the brand kit in a file next to the product, not in your head, and treat it as the source
of truth that the platform profiles and the Docket project are both copied from.

> **Brand fields versus the voice profile.** The three brand fields say what the product *is*;
> the voice profile says how to *write* about it. A voice profile's *Links* are campaign links to
> promote this month — the project's website is what the project is, and the generator is given it
> as brand context ahead of the voice. See [Generator and jobs](generator.md).

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

### 7. Fill in the brand fields and the project defaults

**Settings** → tagline, description and website, so generated posts can say what the product is
and link it without the voice profile repeating it. Owners and admins only; each change is
audited. Then the approval policy and scheduling policy. Decide deliberately whether generated posts
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

A `manage_setup` key can now drive steps 4, 5, 6 and 7 of the runbook above over HTTP:

- `POST /projects` — step 4, create the project (name, slug, timezone, and now the policy and
  brand fields from step 7 in the same call).
- `POST /voice-profiles` and `PATCH /voice-profiles/{profileId}` — step 5, create and later
  refine the voice profile.
- `PATCH /accounts/{accountId}` — step 6's posting-instructions half.
- `POST /slots`, `POST /slots/week`, `PATCH /slots/{slotId}` and `DELETE /slots/{slotId}` —
  step 6's scheduling half: book, move, pause/unpause and delete slots.

See [docs/n8n.md §8](n8n.md#8-provision-a-brand) for a worked example chaining them.

What still has to happen in the browser, because each is human-gated by design:

- **Step 3, the account chain itself.** Connecting Facebook, Instagram, Threads and Bluesky is
  each platform's own OAuth consent; there is no API that stands in for a human authorizing
  Docket.
- **Creating the API key that drives the rest.** A key is always created inside a project in
  **Settings → API keys**, so the first key for a brand-new project is created after step 4, in
  the browser, before any of the calls above can run.
- **Step 1 and step 2**, the brand-kit file and the avatar: these are inputs you write and render
  before scripting anything, not something Docket has an endpoint for.

So onboarding a brand still opens and closes in the browser — write the brand kit, connect the
accounts, create the key — but everything in between (project, voice, instructions, schedule) is
now one scripted pass instead of a manual one.
