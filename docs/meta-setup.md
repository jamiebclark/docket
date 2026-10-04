# Setting up the Meta app (Facebook Pages and Instagram)

Docket publishes to Facebook Pages and to Instagram professional accounts through one Meta app that you create and own.
Follow these steps in order. Nothing here needs App Review: Docket stays on **Standard Access** and only works for people
who have a role on your app.

> Live Facebook and Instagram connect and publishing are verified with mocks only. Items marked **unverified** have not been
> confirmed against Meta's live service.

## 1. Create the app

In the [Meta for Developers](https://developers.facebook.com/apps) dashboard choose **Create app** and pick the **Business** type.

## 2. Add the Facebook Login for Business use case

Add the **Facebook Login for Business** use case to the app. Docket's "Connect with Facebook" button uses it.

Optionally create a **login configuration** with the five permissions listed in step 3, and copy its id into
`META_LOGIN_CONFIG_ID`. When it is set, Docket sends `config_id` with the login request instead of a list of scopes.
Leave it empty to request the scopes directly.

## 3. Permissions

Docket requests these five permissions:

- `pages_show_list`
- `pages_manage_posts`
- `pages_read_engagement`
- `instagram_basic`
- `instagram_content_publish`

`ads_management` and `ads_read` would only be needed for Pages that are managed solely through a Business Manager.
Docket does **not** request them.

## 4. App roles

While the app is on Standard Access, only people with a role on it can connect. Add every Facebook user who will connect
an account as an **admin**, **developer** or **tester** (App roles → Roles).

For Instagram, check that each Page's Instagram professional (Business or Creator) account is **linked to the Page**.
An unlinked Instagram account does not appear in the chooser.

## 5. Stay on Standard Access

Do not submit for App Review. Standard Access is enough for the people in step 4.

## 6. Valid OAuth redirect URIs

In **Facebook Login → Settings**, add these to **Valid OAuth Redirect URIs**:

- Production: `https://<host>/connect/callback`
- Local development: `http://localhost:3000/connect/callback` — **unverified (U2)**. Meta may require HTTPS even for
  localhost.

**Test procedure for U2:** add the localhost URI, start Docket locally, choose Connect with Facebook and sign in.
If you land back on Docket's chooser, it works. If Meta shows "URL blocked" or "redirect URI is not whitelisted",
use the fallback in step 7, or paste a token (step 10).

## 7. Fallback: a hosts-file name plus an mkcert certificate

If localhost is refused, give your machine an HTTPS name:

1. Add `127.0.0.1 docket.local` to your hosts file.
2. Create a certificate with [mkcert](https://github.com/FiloSottile/mkcert): `mkcert -install && mkcert docket.local`.
3. Serve Docket over HTTPS at that name, and add `https://docket.local/connect/callback` to the redirect URIs.

## 8. App id, secret and environment variables

Find the **App ID** and **App Secret** under **App settings → Basic**. Set:

| Variable | Meaning |
|---|---|
| `META_APP_ID` | The App ID. |
| `META_APP_SECRET` | The App Secret. Set both or neither: one without the other is a startup error. |
| `META_GRAPH_VERSION` | Optional. Graph API version. Default `v26.0`. |
| `META_LOGIN_CONFIG_ID` | Optional. The login configuration id from step 2. |

Leave `META_APP_ID` and `META_APP_SECRET` empty to switch the Meta providers off.

## 9. Leave "Require App Secret" off

Under **App settings → Advanced**, leave **Require App Secret** switched **off**. Docket does not send an `appsecret_proof`
(R6), so turning it on makes calls fail.

## 10. Connecting with a Graph API Explorer token

If the redirect flow cannot work for you, paste a token instead:

1. Open the [Graph API Explorer](https://developers.facebook.com/tools/explorer/) and select your app.
2. Choose **User Token** and tick all five permissions from step 3.
3. Click **Generate Access Token** and approve the dialog.
4. Copy the token, open Accounts in Docket, choose Facebook Pages and Instagram, and paste it into the token field.

The pasted token is exchanged for the Pages' tokens and then discarded; it is never stored.

## 11. Media needs a public bucket

Instagram fetches each image by its public URL, so media storage must be a publicly readable bucket. See
[storage.md](storage.md).

## Threads (added by the meta-threads entry)

_Placeholder. The Threads setup steps are added by the meta-threads entry._
