# Setting up X

> **Not checked against the real X API.** Docket's X support has been tested with mocks only. The steps and limits below
> follow X's documentation as read for [research/x.md](research/x.md), and the items marked **unverified** (U1–U9, listed
> at the end) could not be confirmed. If one does not match what you see, please open an issue.

Docket posts to X through **one X developer app that you create and own**. One app serves every project on your
install. X is optional: leave `X_CLIENT_ID` and `X_CLIENT_SECRET` empty and X is simply not offered. Who can connect
which account is in [accounts.md](accounts.md#x).

## Before you start

You need a developer account at the X developer portal, and an address for Docket that X will accept (see below). X
posting through the API is a paid, pay-per-use product: check the current pricing in the portal before you connect
(U5, U8, U9).

## Cost and credits

X's API has no subscription. You buy **credits in advance** in the developer console and X deducts them per request.
You can turn on **auto-recharge** and set a **spending limit**; requests are blocked once the limit is reached.

Costs as read on 2026-10-06 (X changed its prices several times in 2026, so check the portal):

| Request | Cost |
|---|---|
| Create a post | $0.015 |
| Create a post that contains a URL | $0.20 |
| Reads of your own data ("owned reads") | $0.001 per resource |

Docket posts often carry links, so budget about $0.20 per post. New pay-per-use accounts may get **promotional
credits** (as of 2026-10-02: $20 on the first saved card, and the first auto-recharge matched up to $50, expiring after
three months). The cost of media uploads and the `users/me` call is not published (U5).

**When credits run out.** X may answer 429 (not the usual rate window) or 403 (U9). On a 429 that is not the rate
window, Docket waits at least an hour and shows a message that credits or the spending limit may be exhausted; add
credits or raise the limit and the post goes out on a later try. On a 403, Docket does not retry and shows X's own
detail text, or "X refused this as a duplicate of a recent post." when that detail says duplicate.

## Callback address

The callback is always:

```
<BETTER_AUTH_URL>/connect/callback
```

For example, with `BETTER_AUTH_URL=https://docket.example.com` you register `https://docket.example.com/connect/callback`.

- X needs an **`https://` address on a public host**. Docket refuses to start the X login when `BETTER_AUTH_URL` is
  `http://` or `localhost`, and shows why on the Accounts page. Other providers are unaffected.
- X documents `http://127.0.0.1` as allowed for local development. Docket does not use it, because it only works on
  the machine that runs the browser (U4).
- If you change `BETTER_AUTH_URL`, update the callback in the X portal too. It must match exactly.

## 1. Create the app

In the developer portal, create a project and an app. Open the app's **User authentication settings** and set up
**OAuth 2.0**:

1. **App permissions:** choose **Read and write** (U4). Docket does not need direct messages.
2. **Type of app:** **Web App, Automated App or Bot** (a confidential client).
3. **Callback URI / Redirect URL:** the callback address above.
4. **Website URL:** your Docket address.

## 2. Client ID and secret

Under **Keys and tokens**, generate the **OAuth 2.0 Client ID and Client Secret**. Not the API key, the bearer
token or the OAuth 1.0a keys. Set:

| Variable | Value |
|---|---|
| `X_CLIENT_ID` | The OAuth 2.0 Client ID |
| `X_CLIENT_SECRET` | The OAuth 2.0 Client Secret (never logged) |

Set both or neither. With only one set, Docket reports the missing variable at start-up.

## 3. Connect

Open **Accounts → X**, log in to X **as the account to post as** and approve the permissions. Docket asks for
five scopes:

| Scope | Why |
|---|---|
| `tweet.read` | Needed alongside `tweet.write` and to read back the account's posts |
| `tweet.write` | Create the post |
| `users.read` | Read the connected account's name and ID |
| `media.write` | Upload images and set their alt text |
| `offline.access` | Get a refresh token. Without it Docket cannot stay signed in, and the connection is refused |

X access tokens last about two hours; Docket renews them with a refresh token, and renews an idle account before the
refresh token expires (about six months, U3). **Needs reconnecting** means X rejected the refresh token.

## Limits to know about

- Posts are **280 weighted characters**: most characters count 1, CJK and many emoji count 2, links count 23 whatever
  their length. The composer's count is the one Docket enforces.
- Up to **4 images** per post, 5 MB each; JPEG, PNG and WebP are uploaded as they are. Alt text can be up to **1,000**
  characters.
- **Counting can drift.** Docket counts like X's published rules, but X may count links and emoji slightly differently.
  Close to the limit (over 270) a post with a link or emoji shows a warning rather than a block.
- Docket publishes at most 100 posts per 15 minutes per account. X also caps the whole app at 10,000 posts per 24
  hours; Docket does not enforce that, and waits when X reports it (429).
- A post X rejects as a duplicate is not retried. Docket shows "X refused this as a duplicate of a recent post." (U2).

## When a post is ambiguous

If the connection drops after Docket sent the post, Docket cannot know whether X published it. It does not retry, and
marks the post as needing a check. Open the account's profile on X: if the post is there, it went out; if not, post
it again from Docket.

## Not supported

Quote posts (they need an Enterprise plan), video and GIF, polls, replies and threads, direct messages, reading
timelines, deleting posts, and the legacy OAuth 1.0a keys.

## Unverified items (U1–U9)

These could not be confirmed against X's live service. Each has an interim value in `src/providers/x/config.ts` and a
mocked test that accepts either shape.

- **U1.** The one-shot media upload endpoint. Not used: Docket uses the chunked `initialize`, `append`, `finalize` flow.
- **U2.** The exact bodies of 403 (duplicate), 429 and 401 responses. Docket goes by status and only reads `detail`.
- **U3.** The refresh-token lifetime (assumed 180 days) and the body returned for a reused or revoked token.
- **U4.** X's callback rules and whether "Read and write" is the right app permission.
- **U5.** What media uploads and the `users/me` call cost, and any per-user daily cap.
- **U6.** The post URL. Docket links `https://x.com/<username>/status/<id>`, or `https://x.com/i/status/<id>` without a username.
- **U7.** Timeline parameters. Not used.
- **U8.** Whether legacy access tiers still apply to older developer accounts.
- **U9.** Whether exhausted credits answer 429 or 403. Docket waits on 429 and shows X's message on 403.
