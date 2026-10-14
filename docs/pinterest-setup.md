# Setting up Pinterest

Docket posts to Pinterest through **one Pinterest app that you create and own**. One app serves every project on your
install. Pinterest is optional: leave `PINTEREST_CLIENT_ID` and `PINTEREST_CLIENT_SECRET` empty and Pinterest is simply
not offered. Who can connect which account is in [accounts.md](accounts.md#pinterest).

Pinterest only lets a **business account** register a developer app. If you only have a personal account, convert it
first (free, in Pinterest's own settings) before registering the app below.

> **Connect business accounts, not personal ones.** For any app registered **on or after 14 September 2026**,
> Pinterest answers `403 PINNER_DATA_ACCESS_DENIED` — "your application must be approved for pinner data access" —
> when it reads a board or Pin belonging to a **non-business** user. Pinterest's own advice is not to retry it:
> approval has to be arranged through an account manager. The call Docket's board picker makes (listing the
> connected account's own boards) is not among the endpoints Pinterest names, so a personal account may well work —
> but that is read from an omission, not something Pinterest states, so connect business accounts and treat a
> personal one as unsupported.

**One app serves every project on the server.** `PINTEREST_CLIENT_ID` and `PINTEREST_CLIENT_SECRET` are per
installation, not per project, exactly like the Meta, X and TikTok credentials. Each project then connects its own
Pinterest account through that one app by the normal authorisation flow — an account does not need to own the app,
or be related to whoever registered it. Register the app under an account that represents **the installation**
rather than one brand, so that handing a brand over later does not hand over every other project's connection with
it. Note the cost of sharing one app: on Trial access the 300-creations-a-day cap is shared across every connected
account on the server (see [Trial rate limits](#trial-rate-limits)).

> **Unverified steps.** Docket's Pinterest support has been tested with mocks only. The steps below follow Pinterest's
> own documentation (checked 2026-10-14, sources in [research/pinterest.md](research/pinterest.md)) but have not been
> run against Pinterest's live service. Steps marked **unverified** could not be confirmed. If one does not match what
> you see, please open an issue. The checks to run once your app has Trial access are listed at the end
> ([Owed live checks](#owed-live-checks)).

## 1. Register the app and request Trial access

In the [Pinterest Developers](https://developers.pinterest.com/) portal, register an app under your business account.
Every new app starts with **Trial access**:

- Trial requests are **reviewed each business day**.
- Pinterest can **refuse** a request whose privacy policy is inaccessible or whose description of what the app does is
  unclear. Make sure both are in place before you submit.
- While your app has Trial access, every pin and board it creates is **visible only to its owner** — the connected
  account — even if the board is public. Submitting a post through Docket while on Trial does not make it public.
- To move from Trial to **Standard** access (public pins), Pinterest asks for a **demo video of the full flow**:
  connecting the account, composing and publishing a pin, and the published pin visible on Pinterest.

## Callback address

The callback is always:

```
<BETTER_AUTH_URL>/connect/callback
```

For example, with `BETTER_AUTH_URL=https://docket.example.com` you register
`https://docket.example.com/connect/callback` in the Pinterest app's redirect URI settings.

- Pinterest needs an **`https://` address on a public host**. Docket refuses to start the Pinterest login when
  `BETTER_AUTH_URL` is `http://` or `localhost`, and shows why on the Accounts page. Other providers are unaffected.
- If you only have a local address, see [Local HTTPS for Threads](meta-setup.md#local-https-for-threads); the same
  approach works for Pinterest.
- **Pinterest matches it exactly.** If you change `BETTER_AUTH_URL`, update the registered redirect URI in the
  Pinterest app too — a trailing slash or a different scheme is a different address as far as Pinterest is concerned.

## 2. Client ID, secret and environment variables

Copy the app's **App ID** and **App secret** and set:

| Variable | Value |
|---|---|
| `PINTEREST_CLIENT_ID` | The app's App ID |
| `PINTEREST_CLIENT_SECRET` | The app's App secret (never logged) |

Set both or neither. With only one set, Docket reports the missing variable at start-up and Pinterest is shown as
**unavailable**. With neither set, Pinterest is **not configured on this server** and no connect action is offered.
**Restart Docket after editing them.**

## 3. Connect

Open **Accounts → Pinterest** and log in as the account to post as. Docket asks for the minimum scopes needed to
connect, list boards and publish (`user_accounts:read`, `boards:read`, `pins:write`) — nothing that reads existing
pins and nothing that creates or edits boards. The account is named after its business name, or its Pinterest
username if no business name is set. Access tokens are renewed automatically; **Needs reconnecting** means Pinterest
rejected the refresh token.

## Trial rate limits

While the app has Trial access, Pinterest caps the whole app at **300 a day** for pin creations (`org_write`,
reviewed), shared across every connected account. Docket does not model that daily cap (it is per app, not per account) — a post
that would exceed it is deferred, not failed, when Pinterest reports a 429. Once the app is upgraded to **Standard**
access, the limit becomes **100 a minute** per user per app, which is what Docket's publish limit models. Both
numbers, and the Trial visibility rule, are shown on the account card, in the composer's requirements summary and
above the posting fields.

## `api-sandbox` is a different thing

Pinterest publishes a separate `api-sandbox.pinterest.com` host for testing against fake data. **Docket never calls
it.** Every Pinterest request Docket makes goes to the real `api.pinterest.com` and `www.pinterest.com` hosts, under
whatever access tier (Trial or Standard) your app currently has.

## Verification status

This provider has been **verified against mocked responses only** — no code path here has been exercised against
Pinterest's real API. The steps above follow Pinterest's published documentation as read on 2026-10-14. See
[Owed live checks](#owed-live-checks) for what a deployer with a real, Trial-approved app should confirm.

## What this entry does not do

Video pins, carousel pins, board management (creating or editing boards), secret or protected boards, analytics,
product/rich pins, catalogs, ads, Pinterest Business Access, AI-disclosure labels, automatic detection of Trial vs.
Standard access, and modelling the shared Trial daily cap as an enforced limit.

## Owed live checks

Nothing here is owed until a real, Trial-approved Pinterest app and a connected account are available. All Pinterest
behaviour is verified with mocks only.

- **U1** — does Pinterest accept a non-https or localhost redirect URI?
- **U2** — the error body for 400, 401, 403, 404, 429 and 5xx.
- **U3** — is 20 MB enforced? Any pixel bounds? Is an out-of-range aspect ratio refused or just cropped?
- **U4** — how `title`, `description` and `alt_text` are counted.
- **U5** — the real permalink of a created pin.
- **U6** — whether PKCE is accepted at all.
- **U7** — the `account_type` values a business account returns.
- **U8** — whether a legacy 365-day refresh token rotates.
- **U9** — whether a revoked grant surfaces as anything other than a 401.
- **U10** — whether the organic Pins API is region-restricted.
- **The one thing no mock can show:** that a pin created by a Trial app is invisible to anyone but the connected
  account's owner, and that it becomes visible once Standard access is granted.
