# Setting up TikTok

Docket posts to TikTok through **one TikTok app that you create and own**. One app serves every project on your install.
TikTok is optional: leave `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` empty and TikTok is simply not offered. Who can
connect which account is in [accounts.md](accounts.md#tiktok).

> **Unverified steps.** Docket's TikTok support has been tested with mocks only. The steps below follow TikTok's
> documentation (checked 2026-10-07, sources in [research/tiktok.md](research/tiktok.md)) but have not been run against
> TikTok's live service. Steps marked **unverified** could not be confirmed. If one does not match what you see, please
> open an issue. The checks to run once your app is audited are listed at the end ([Owed live checks](#owed-live-checks)).

## Before you start

TikTok only lets an app post publicly after it passes TikTok's **audit**. Until then, every post Docket sends is private
("Only me"). You can set everything up and try it first, then apply for the audit (see
[Applying for the audit](#applying-for-the-audit)).

## Callback address

The callback is always:

```
<BETTER_AUTH_URL>/connect/callback
```

For example, with `BETTER_AUTH_URL=https://docket.example.com` you register `https://docket.example.com/connect/callback`.

- TikTok needs an **`https://` address on a public host**. Docket refuses to start the TikTok login when
  `BETTER_AUTH_URL` is `http://` or `localhost`, and shows why on the Accounts page. Other providers are unaffected.
- If you only have a local address, see [Local HTTPS for Threads](meta-setup.md#local-https-for-threads); the same
  approach works for TikTok.
- If you change `BETTER_AUTH_URL`, update the redirect URI in the TikTok portal too. It must match exactly.

## 1. Register the app

In the [TikTok for Developers](https://developers.tiktok.com/) portal, register as a developer and choose **Manage apps →
Connect an app**. An **organisation** account is recommended over a personal one. The portal asks for:

- An app **icon**, **name** and **description**.
- A **Terms of Service URL** and a **Privacy Policy URL**. Docket does not serve these pages; you must supply addresses
  that exist.
- The platform: **Web**, with your Docket address as the web URL.

## 2. Add the products

Add both products to the app:

1. **Login Kit**, for connecting an account.
2. **Content Posting API**, with **Direct Post** switched on. Docket sends posts directly; it does not use inbox
   (draft) upload.

### Scopes

Docket asks for two scopes at connect time:

| Scope | Why |
|---|---|
| `user.info.basic` | Read the account's `open_id` (its identity), name and avatar |
| `video.publish` | Post to the account. A grant without it is refused and nothing is saved |

### Redirect URI

Under Login Kit, add the callback address above as a redirect URI. TikTok's rules (web): it must be absolute and begin
with `https`, be static (no query parameters), have no fragment, be under 512 characters, and you can register at most 10.

## 3. Sandbox and Production

The portal offers a **Sandbox** (try the integration without review) and **Production** (a version submitted for review).
The sandbox rules (how many test users, what works) are **unverified**: the page was not reachable when this was
written. Docket does not depend on either; it only needs the client key and secret from the app.

## 4. Client key, secret and environment variables

Copy the **Client key** and **Client secret** from the app's page and set:

| Variable | Value |
|---|---|
| `TIKTOK_CLIENT_KEY` | The app's client key |
| `TIKTOK_CLIENT_SECRET` | The app's client secret (never logged) |
| `TIKTOK_APP_AUDITED` | `true` or `false` (default `false`). See [When to set TIKTOK_APP_AUDITED](#when-to-set-tiktok_app_audited) |

Set `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` both or neither. With only one set, Docket reports the missing variable
at start-up. **Restart Docket after editing them.**

## 5. Connect

Open **Accounts → TikTok**, log in to TikTok **as the account to post as** and approve the permissions. The account is
named "nickname (@username)". Access tokens are renewed automatically; **Needs reconnecting** means TikTok rejected the
refresh token. Docket warns 30 days before the refresh token is estimated to expire.

## Unaudited apps

Until TikTok audits the app:

- Every post is **private**: Docket shows "Only me (private)" as the only choice and marks the target "Private on TikTok"
  wherever its status is shown.
- The TikTok account itself must be **private**; TikTok answers `unaudited_client_can_only_post_to_private_accounts`
  otherwise.
- At most **5 users** may post through the app in 24 hours.
- TikTok allows about **15 posts per creator per day**, audited or not (a cap shared with other apps). Docket waits
  when TikTok reports it.
- A published private post has no public link, so Docket records TikTok's `publish_id` and shows no link.

## Photo posts and domain verification

TikTok fetches photos itself, from the **public `https` address** of the files in your media bucket. TikTok will only
fetch from an address you have verified:

- In the app's **URL properties**, verify either a **domain** (a signature string in a DNS record; every path and
  subdomain then counts) or a **URL prefix** (`https://` + host + path + `/`, with TikTok's signature file hosted at that
  address). The host must be a domain, not an IP.
- Verification needs the app in **Production** mode (whether review must pass first is **unverified**).
- A **raw bucket endpoint you do not own cannot be verified**. Serve your media from a custom domain, as recommended in
  [storage.md](storage.md#cloudflare-r2-custom-domain).
- The address must not redirect, and must be reachable over `https`.
- **Video does not need this**: Docket uploads video bytes straight to TikTok.

An unverified domain makes a photo post fail with `url_ownership_unverified`, explained in plain words. Docket cannot
check your verification; the requirements summary and the account card carry the note "Photo posts need your media
domain verified in your TikTok app."

## The posting fields and consent

Each TikTok target in the composer shows the account's live options and fields TikTok requires: who can view the post (no
default; you must choose), Comment, Duet and Stitch (all off, and disabled if the creator turned them off), the
commercial-content disclosure ("Your brand" and "Branded content"), the title, and TikTok's consent declaration with an
unticked "I agree". A post cannot be scheduled, queued or approved with a TikTok target until it is ticked. Docket
records who agreed, when, and a fingerprint of the content, the fields and the creator details shown. **Any later change
clears the consent**, and a duplicated post does not inherit it.

> **Risk (unverified).** TikTok asks for express consent before content is sent. Whether consent given when a post is
> scheduled, for a later automated send, passes TikTok's audit is not known. If TikTok refuses it, a confirm-at-send flow
> would be needed. It is not built and no spec owns it ([feature-map.md](feature-map.md)).

## Applying for the audit

Use the app's page in the portal. What TikTok asks for (as read; the audit route itself is **unverified**):

- A **demo video of the full flow**: at most 5 videos of 50 MB each.
- A description of the app.
- Review time: app review "may take several days to two weeks"; the Content Posting audit has no published duration.
- To raise the posting caps afterwards, use TikTok's **Support form**.

What to show in the demo: connecting the account; the composer's TikTok fields with **no default privacy**, the
disclosure choices and the consent checkbox; scheduling the post; and a published post on TikTok.

## When to set TIKTOK_APP_AUDITED

Set `TIKTOK_APP_AUDITED=true` **only after TikTok has told you the audit passed**, then restart Docket. Docket then offers
the creator's own privacy options instead of the fixed "Only me (private)". Setting it earlier makes posts fail with
`unaudited_client_can_only_post_to_private_accounts`. Remove the variable (or set `false`) to go back.

## Local HTTPS

TikTok refuses `http://` and `localhost` redirect addresses. See
[Local HTTPS for Threads](meta-setup.md#local-https-for-threads) for a local certificate and a tunnel-free address.

## Owed live checks

Nothing here is owed **until the app is audited**; run these together then. All TikTok behaviour is verified with mocks
only.

- **Connect:** the granted scopes, the `open_id`, the token reply's fields, and that PKCE is not needed.
- **Creator info:** the shape of the reply (privacy options, interaction toggles, maximum duration).
- **Video:** a public and a private video; a 1 GiB video (about 35.8 MB per chunk) at the default time limit; a
  repeated chunk after a timeout.
- **Photo:** a photo post from a verified domain.
- **Status:** the replies at each stage, and the public post id and link format.
- **Refresh:** a refresh with rotation, and the refresh token's expiry field.
- **Consent:** whether consent at scheduling was accepted in the audit.

## Not supported

Inbox (draft) upload, webhooks, revoking the grant on disconnect, a Docket route that serves media from Docket's own
domain, video pulled from a URL, AI-generated-content labelling, a cover frame choice, music options, TikTok fields in
the public API, generator or bulk create, and counting TikTok accounts across the install against the 5-user cap.
