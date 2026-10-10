# Members, roles and connecting accounts

This page covers who can do what in a project, how to connect each platform, and how to schedule for accounts that belong
to someone else (a friend's Page, a client's Instagram).

> **What "unverified" means here.** Docket's tests use mocks and never call a real platform. Steps marked **unverified**
> follow the platform's documentation but have not been tried against the live service. You may be the first person to
> run them. If one does not work as written, please open an issue with what you saw.

## One app per install, every project

You create one Meta app (for Facebook, Instagram and Threads) per Docket install, not one per project. Every project on
the install connects its own Pages and accounts through that app. Two things follow:

- The app's name appears on the login screen for everyone who connects, including clients.
- If Meta restricts the app, or you delete it, every project loses its Facebook, Instagram and Threads connections at
  once.

Bluesky needs no app at all.

## Roles

Each project has its own members. A person can be an owner in one project and an editor in another.

| Action | Owner | Admin | Editor |
|---|:-:|:-:|:-:|
| Write, edit, schedule and delete posts; upload media | ✓ | ✓ | ✓ |
| Run the generator | ✓ | ✓ | ✓ |
| Auto-approve generated posts (skip review) | ✓ | ✓ | |
| **Connect, reconnect and remove accounts**; edit posting slots | ✓ | ✓ | |
| Manage voice profiles | ✓ | ✓ | |
| Invite members, revoke invitations | ✓ | ✓ | |
| Invite another owner, change roles, transfer ownership | ✓ | | |
| Remove members | ✓ | ✓ (not owners) | |
| API keys and webhooks | ✓ | ✓ | |
| Edit project settings | ✓ | ✓ | |

Source of truth: `src/server/auth/access.ts`.

### Inviting people

Docket sends no email. An owner or admin invites someone by email address with a role:

- If that email already has a Docket login, they see the invitation in the app and can accept or decline.
- Otherwise Docket shows a single-use sign-up link. Copy it and send it to them yourself.

Invitations expire after `INVITATION_TTL_DAYS` (default 7) and can be revoked or regenerated.

## Who can connect an account

The person who clicks **Connect** needs two things:

1. The **owner** or **admin** role in that Docket project.
2. The platform-side access in the table below.

| Platform | The connecting person needs |
|---|---|
| Bluesky | The account's handle and an app password for it |
| Facebook Page | A role on your Meta app (admin, developer or tester), **and** a task on the Page that lets them create content |
| Instagram | The same as Facebook, for the Page the Instagram account is linked to |
| Threads | To be logged in to Threads **as that account**, and that account must be a Threads Tester on your app |
| X | To be logged in to X **as that account**, with your X developer app set up ([x-setup.md](x-setup.md)) |

## Posting instructions

Each connected account has an optional **Posting instructions** field (up to 2,000 characters) on the Accounts screen, just above its posting slots. It tells the generator how posts for that account are written: hashtags, links, how a post opens. The brand voice stays on the voice profile; see [generator.md](generator.md#posting-instructions) for how the instructions are used.

- **Who can edit.** Owners and admins, enforced on the server. Editors see the text read-only.
- **Audit.** Each change appears in the project's activity log (Settings → Members) with the previous and new text. Saving without changing the text writes nothing.
- **Reconnecting** an account keeps its instructions. Removing an account and connecting it again starts it with none.
- **Also available** read-only as `postingInstructions` from `GET /api/v1/accounts` and in `account.*` webhook bodies.

## Bluesky

Bluesky connects with an **app password**, not the account's main password.

1. In Bluesky's settings, find **App passwords** (under privacy and security) and create one named "Docket".
2. In Docket, open the project's **Accounts** screen, choose **Bluesky** and enter:
   - **Handle**: the Bluesky handle, without the `@`.
   - **App password**: the one you just created.
   - **Server (PDS) address**: leave the default unless the account lives on a self-hosted server; then enter its
     `https://` address.

**Stored:** the session tokens Bluesky returns, plus the account's DID and handle, encrypted. **Not stored:** the app
password. It is used once to open the session and then thrown away, so every reconnect needs an app password again.

**Needs reconnecting** means Bluesky refused to renew the session (the app password was revoked, or the session
expired). Enter an app password again from Accounts. Revoking the app password is done in Bluesky.

Video needs nothing more at connect: there is no new connection step. A Bluesky-hosted account must have a **verified email**
address to upload video, and Bluesky allows about 25 videos a day.

The live Bluesky connect is **unverified**. Real video publishing is verified with mocks only. Owed live checks (quickstart §7):
publish a 30 s MP4; confirm the host and token audience for upload, limits and status calls; record `partSizeBytes` and part timing and
the processing time; publish a 4-minute video with a raised maximum duration; and confirm `Range` requests get a 206 from the public
media URL.

## Facebook Pages and Instagram

First create the Meta app: [meta-setup.md](meta-setup.md). Then, in Docket, open **Accounts**, choose **Facebook Pages
and Instagram**, sign in with Facebook, and pick the Pages and linked Instagram accounts to connect.

- **Instagram must be a professional account** (Business or Creator) and **linked to a Facebook Page**. An unlinked or
  personal Instagram account does not appear in the chooser.
- **What is stored:** each Page's access token, and each Instagram account's link to its Page, encrypted. The
  connecting person's own Facebook login token is never stored.
- **Needs reconnecting** means Meta rejected a stored token. The usual causes: the connecting person changed their
  Facebook password, removed the app, or lost their role on the Page or the app.
- **Media must be public.** Facebook and Instagram both fetch each image from its URL, so the media bucket must be
  publicly readable ([storage.md](storage.md)).
- **Removing access:** removing an account in Docket deletes its stored tokens. To revoke the app entirely, the
  connecting person opens Facebook Settings → Business Integrations (or Apps and Websites) and removes it.

## X

First create the X developer app: [x-setup.md](x-setup.md). Then open **Accounts** and choose **X**.

- **Log in to X as the account to post as.** X posts as whoever approves the login; there is no delegated access.
- **HTTPS is required.** X needs an `https://` callback on a public host, so the button is unavailable (with the
  reason) on `http://` or `localhost` ([x-setup.md#callback-address](x-setup.md#callback-address)).
- **Needs reconnecting** means X rejected the stored refresh token.
- **What is stored:** the access token and the rotating refresh token (encrypted), with their expiry times, and the X
  account's ID and username. Nothing else.
- **Verified with mocks only; not checked against the live X API.** See the notice in [x-setup.md](x-setup.md).
- **Removing access:** removing the account in Docket deletes its tokens. To revoke the app entirely, open X Settings →
  Security and account access → Connected apps.

## Threads

First add the Threads use case to the Meta app: [meta-setup.md#threads](meta-setup.md#threads). Then open **Accounts**
and choose **Threads**.

- **Each Threads account must be a Threads Tester** on your app and must have accepted the invite (see
  [meta-setup.md](meta-setup.md#threads-testers)). A missing acceptance is the first thing to check when the login is
  refused.
- **HTTPS is required.** Threads refuses `http://` and `localhost` addresses, so the login button only works when
  `BETTER_AUTH_URL` is an `https://` address that is not localhost.
- **What is stored:** the long-lived access token and its issue and expiry times, encrypted. It lasts about 60 days, and
  Docket renews it automatically ahead of expiry (once it is at least 24 hours old).
- **Needs reconnecting** means Threads rejected the token (it expired, or access was removed).
- **Removing access:** removing the account in Docket deletes the token. To revoke the app entirely, open Threads
  Settings → Account → Website permissions and remove it.

## TikTok

First register the TikTok app: [tiktok-setup.md](tiktok-setup.md). Then open **Accounts** and choose **TikTok**.

- **HTTPS is required.** TikTok refuses `http://` and `localhost` redirect addresses, so the login button only works
  when `BETTER_AUTH_URL` is an `https://` address that is not localhost.
- **Log in as the account to post as** and allow posting. A grant without the posting permission is refused.
- **Until your app is audited by TikTok, every post is private** ("Only me (private)") and the TikTok account must be
  private. See [what an unaudited app can do](tiktok-setup.md#unaudited-apps).
- **Each post needs consent.** The composer shows TikTok's declaration with an "I agree" checkbox; a post cannot be
  scheduled until it is ticked, and any later change clears it.
- **What is stored:** the access and refresh tokens, encrypted. Docket renews them automatically; **Needs reconnecting**
  means TikTok rejected the refresh token.
- **Removing access:** removing the account in Docket deletes its tokens. To revoke the app entirely, remove it in
  TikTok's app settings (Docket does not revoke the grant itself).

## Scheduling for someone else's accounts

A common setup: you run Docket, and a friend or client owns the Page and accounts you post for.

| Platform | Who connects | What the account owner does |
|---|---|---|
| Facebook Page | You | Gives your personal Facebook profile access to **the Page itself**, with permission to create content |
| Instagram | You, with the Page | Makes the Instagram account professional and links it to that Page |
| Threads | **The owner** | Accepts the Threads Tester invite, then connects while logged in to their own Threads |
| X | **The owner** | Connects while logged in to their own X, or lets you log in as them |
| Bluesky | Either of you | Creates an app password and gives it to you, or types it in themselves |

**Facebook and Instagram.** When you connect with your own Facebook login, the stored Page tokens come from **your**
access. If you lose your role on the Page, or change your Facebook password, the accounts show **Needs reconnecting**.
The owner does not need a role on your Meta app in this setup. Alternatively, add the owner as a tester on your app, make
them an admin in the Docket project, and let them connect it themselves.

**Pages in a Business Portfolio (Business Manager).** A Page owned by a Business Portfolio does not appear in Docket's
chooser. This is a limitation in Docket, not a permission the connecting person is missing: `/me/accounts`, the only
call Docket uses to find Pages, does not list such a Page at all.

Measured against a live install, with the Page granted in the login dialog and the five permissions held:

| Call | Result |
|---|---|
| `GET /me/accounts?fields=id,name,access_token` | `{"data": []}` — the Page is absent entirely |
| `GET /<page-id>?fields=id,name,access_token,instagram_business_account` | returns the Page, **with** a Page access token and its linked Instagram account |
| `GET /me/businesses` | `(#100) Missing Permission` — needs `business_management` |

So the Page token exists and is reachable; only the enumeration fails. The person connecting had **full control** of the
Page, and the Page was offered and accepted in Facebook's own login dialog.

**Does not help, each tried and measured:**

- `ads_management` and `ads_read` on top of the five. Meta grants both under Standard Access with no App Review, and
  `/me/accounts` stays empty. An earlier version of this page claimed these were the fix; they are not.
- Adding the Docket app to the Page's Business Portfolio (which makes that portfolio the app's owner).
- Re-running the login through **Edit settings** so the grant is issued fresh instead of reused from cache.

**The fix is to stop depending on `/me/accounts`.** The Page ids a person granted are available from `/debug_token`
(`granular_scopes[].target_ids`), which Docket's server can call with an app token built from `META_APP_ID` and
`META_APP_SECRET`. Each id then resolves through `GET /<page-id>?fields=id,name,access_token,instagram_business_account`,
which is the call shown working above. This needs no permission beyond the five Docket already requests. Until that
lands, a portfolio-owned Page cannot be connected.

**What works today.** Pages held directly by the connecting person, outside any Business Portfolio, connect normally
with the five permissions — `/me/accounts` lists those. If you control the Page, moving it out of the portfolio is the
only route confirmed to work.

**Threads.** Threads offers no way to let someone else manage an account: the person who logs in during **Connect** is
the account that gets connected. So the owner must do this step. The simplest way:

1. Add their Threads account as a Threads Tester on your app, and ask them to accept.
2. Invite them into the Docket project as an **admin** (editors cannot connect accounts).
3. They open Accounts → Threads and connect while logged in to their Threads.

After that you can schedule to the account normally, and the token renews by itself. They can change their role back to
editor, or leave the project, without breaking the connection. (**Unverified**: Meta's docs do not say outright that
Threads has no delegated access; nothing in them describes one.)

**Bluesky.** Ask the owner to create an app password named after you or Docket, and to send it over a private channel.
They can revoke it at any time without changing their main password. Because Docket does not keep it, a later reconnect
needs a new one.
