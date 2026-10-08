# Setting up the Meta app (Facebook Pages, Instagram and Threads)

Docket publishes to Facebook Pages, Instagram professional accounts and Threads through **one Meta app that you create
and own**. One app serves every project on your install; you do not need one per project or per client. Who can connect
which account, and how to post for someone else's Page, is in [accounts.md](accounts.md).

Docket stays on **Standard Access** and never needs App Review, so the app only works for people who have a role on it.

> **Unverified steps.** Live Facebook, Instagram and Threads connect and publishing have been tested with mocks only.
> Steps marked **unverified** follow Meta's documentation (checked 2026-10-04, sources in
> [research/meta.md](research/meta.md)) but have not been run against Meta's live service. If one does not match what you
> see, please open an issue.

## Before you start

You need the address Docket will run at, because Meta checks the login callback against it. The callback is always:

```
<BETTER_AUTH_URL>/connect/callback
```

For example, with `BETTER_AUTH_URL=https://docket.example.com` you register `https://docket.example.com/connect/callback`.
If you change `BETTER_AUTH_URL` later, update the callback in the Meta dashboard too.

Docket itself does **not** need to be reachable from the internet: the login redirect happens in your browser. A LAN
address works as long as it is `https://` with a certificate your browser trusts. The media bucket is different: Meta
fetches images from it, so it must be public ([storage.md](storage.md)).

## 1. Create the app

In the [Meta for Developers](https://developers.facebook.com/apps) dashboard choose **Create app** and pick the
**Business** type. You need a Meta developer account; it is free.

## 2. Add the Facebook Login for Business use case

Add the **Facebook Login for Business** use case. Docket's "Connect with Facebook" button uses it.

Optionally create a **login configuration** with the five permissions in step 3, choosing **User access token** as the
token type (not System-user access token). Copy its id into `META_LOGIN_CONFIG_ID`; Docket then sends `config_id` with
the login request instead of a list of scopes. Leaving it empty is fine: Docket requests the scopes directly.

## 3. Permissions

Docket requests these five:

- `pages_show_list`
- `pages_manage_posts`
- `pages_read_engagement`
- `instagram_basic`
- `instagram_content_publish`

Docket does **not** request `ads_management` or `ads_read`. Meta requires those when the connecting person's access to
a Page comes only through a Business Portfolio (Business Manager); see
[accounts.md](accounts.md#scheduling-for-someone-elses-accounts).

## 4. App roles

Only people with a role on the app can connect. Add every Facebook user who will click **Connect** in Docket as an
**admin**, **developer** or **tester** under **App roles → Roles**.

They also need access to what they connect:

- **Facebook Page:** a task on the Page that lets them create content (or full control).
- **Instagram:** the Instagram account must be a professional (Business or Creator) account **linked to a Page** the
  person has that access to. An unlinked account does not appear in the chooser.

## 5. App mode and Standard Access

Do not submit for App Review. Standard Access covers everyone with a role from step 4.

Meta's documentation says Business apps have no Development/Live mode and use access levels only, but some dashboard
pages still describe a mode toggle (**unverified** which one you will see). If your dashboard shows a toggle, people with
app roles can connect in either mode. Going Live may ask for a privacy policy URL, an app icon and a category; Business
Verification is not needed while only people with roles connect.

## 6. Valid OAuth redirect URIs

Open **Facebook Login for Business → Settings** and, under **Client OAuth Settings**, add your callback to **Valid OAuth
Redirect URIs** (**unverified**: Meta moves dashboard labels around):

- Your install: `<BETTER_AUTH_URL>/connect/callback`, for example `https://docket.example.com/connect/callback`.
- Local development, if you want it: `http://localhost:3000/connect/callback`. **Unverified:** Meta documents an
  exception for `localhost` only for apps in development mode, and Business apps may not have one.

You can register several addresses at once (production, local), so switching does not mean editing the dashboard.

**To test the localhost address:** start Docket locally, choose Connect with Facebook and sign in. If you land back on
Docket's chooser, it works. If Meta says "URL blocked" or "redirect URI is not whitelisted", use step 7 or step 10.

## 7. Fallback: a local HTTPS address

If `localhost` is refused, give your machine an HTTPS name. The steps are the same as for Threads: follow
[Local HTTPS for Threads](#local-https-for-threads) and register that address's callback (for example
`https://docket.local:3000/connect/callback`).

## 8. App id, secret and environment variables

Find the **App ID** and **App Secret** under **App settings → Basic**. Set:

| Variable | Meaning |
|---|---|
| `META_APP_ID` | The App ID. |
| `META_APP_SECRET` | The App Secret. Set both or neither: one without the other is a startup error. |
| `META_GRAPH_VERSION` | Optional. Graph API version. Default `v26.0`. |
| `META_LOGIN_CONFIG_ID` | Optional. The login configuration id from step 2. |

Leave `META_APP_ID` and `META_APP_SECRET` empty to switch the Facebook and Instagram providers off. Docket reads these at
startup, so restart after editing `.env` (with Compose: `docker compose up -d`).

## 9. Leave "Require App Secret" off

Under **App settings → Advanced**, leave **Require App Secret** switched **off**. Docket does not send an
`appsecret_proof`, so turning it on makes calls fail.

## 10. Connecting with a Graph API Explorer token

If the redirect cannot work for you, paste a token instead. This needs no callback, so it also works on `localhost`.

1. Open the [Graph API Explorer](https://developers.facebook.com/tools/explorer/) and select your app.
2. Choose **User Token** and tick all five permissions from step 3.
3. Click **Generate Access Token** and approve the dialog.
4. In Docket, open Accounts, choose Facebook Pages and Instagram, and paste it into the token field.

The pasted token is exchanged for the Pages' tokens and then thrown away; it is never stored.

## 11. Media needs a public bucket

Facebook and Instagram both fetch each image from its URL, so media storage must be a publicly readable bucket. See
[storage.md](storage.md).

## Instagram video: owed live checks

Instagram video needs **no new permission**: `instagram_content_publish` already covers Reels, feed video and carousels.
Until the owner runs these four checks in one sitting, Instagram video is "verified with mocks only". Report all results together.

1. **Reel.** Publish one video as **Reel**. It should appear only in the Reels tab.
2. **Feed video.** Publish one video as **Feed video**. It should appear in the feed grid and the Reels tab.
3. **Mixed carousel.** Publish a carousel of image, video and image. This confirms that a video item created with `media_type`
   omitted is accepted. If Instagram refuses it, the target fails at `create_item_2` with Instagram's message and nothing is
   published; report the message (`VIDEO_ITEM_MEDIA_TYPE` in `src/providers/instagram/requests.ts` is a one-line change).
4. **Large file.** Publish a Reel of roughly 200 to 300 MB. This confirms that Instagram fetches a large file from the bucket by
   `video_url`, and shows how long processing takes.

## Threads

Threads has its own app id and secret, separate from the App ID and App Secret above. You can add it to the same Meta app
(**unverified**: Meta allows Threads alongside some use cases and not others; if the dashboard refuses, create a second
app just for Threads).

### Threads: add the use case

1. In the [Meta for Developers](https://developers.facebook.com/apps) dashboard open your app and add the **Access the
   Threads API** use case.
2. Under the use case's permissions, add the two Docket needs: `threads_basic` and `threads_content_publish`.
3. Open the use case's settings and copy the **Threads app ID** and **Threads app secret**. These are **not** the App ID
   and App Secret from step 8.

### Threads: testers

Without App Review, only Threads Testers can connect. Going beyond testers needs App Review and a published app, which
Docket does not cover.

1. Under **App roles → Roles → Add People**, choose **Threads Tester** and add each Threads account that will connect.
2. Each account's owner accepts the invite in Threads under **Website permissions** in account settings (**unverified**:
   the exact menu path; it has been seen as Settings → Account → Website permissions).

There is no delegated access on Threads: the person who logs in during Connect is the account that gets connected. To
connect a Threads account you do not own, see [accounts.md](accounts.md#scheduling-for-someone-elses-accounts).

### Threads: redirect addresses

In the Threads use case's settings add `<BETTER_AUTH_URL>/connect/callback`, for example
`https://docket.example.com/connect/callback`.

- Threads refuses `http://` and `localhost` addresses. Docket checks this before sending you there and shows a reason and
  a link here. For local use, see [Local HTTPS for Threads](#local-https-for-threads).
- **Ports (unverified):** the dashboard may refuse a non-default port such as `:3000`. If it does, serve Docket on 443
  (behind a reverse proxy, or a port forward from 443 to 3000) and register the address without a port.
- **Uninstall and delete callback fields (unverified):** the dashboard may insist on these. Docket has no such endpoint;
  enter your base address (your `BETTER_AUTH_URL`).

### Threads: environment variables

| Variable | Meaning |
|---|---|
| `THREADS_APP_ID` | The Threads app ID. |
| `THREADS_APP_SECRET` | The Threads app secret. Set both or neither: one without the other is a startup error. |
| `THREADS_GRAPH_BASE` | Optional. Graph address for Threads. Default `https://graph.threads.com`. Must be `https` with no path. |

Leave `THREADS_APP_ID` and `THREADS_APP_SECRET` empty to switch Threads off. Restart after editing `.env`.

### Threads: pasting a token instead (unverified)

If the redirect cannot work, paste a token. Like the Facebook token in step 10, this needs no callback.

1. In the dashboard open the Threads use case and find the **User Token Generator** (its location may differ).
2. Generate a token for your tester account with `threads_basic` and `threads_content_publish`.
3. In Docket open Accounts, choose Threads and paste it.

Docket first tries to exchange it for a long-lived token, then to renew it, and otherwise saves it as it is with an
estimated expiry shown on the account. Whichever form is saved is encrypted.

### Local HTTPS for Threads

For local development without a reverse proxy, give your machine a name and a trusted local certificate. This uses
`pnpm dev:https`, so it runs Docket from a source checkout, not Compose. The name `docket.local` below is an example; any
name works if you change it in every step, including the `dev:https` script in `package.json`. Media still needs a
public bucket ([storage.md](storage.md)).

1. **Hosts entry.** Add `127.0.0.1 docket.local` to your hosts file:
   - macOS and Linux: `/etc/hosts` (edit with `sudo`).
   - Windows: `C:\Windows\System32\drivers\etc\hosts` (edit as Administrator).
2. **mkcert.** Install [mkcert](https://github.com/FiloSottile/mkcert) (a developer tool; Docket does not depend on it),
   then:
   ```sh
   mkcert -install
   mkdir -p certificates
   mkcert -key-file certificates/docket.local-key.pem -cert-file certificates/docket.local.pem docket.local
   ```
   `certificates/` is git-ignored.
3. **Public address.** Set `BETTER_AUTH_URL=https://docket.local:3000` in `.env`.
4. **Start over HTTPS.** Run `pnpm dev:https`. It runs `next dev` with `--experimental-https`, your key and certificate,
   and `-H docket.local`.
5. **Register the callback.** Add `https://docket.local:3000/connect/callback` in the Threads use case (and in Facebook
   Login for Business if you use it locally).
6. Open `https://docket.local:3000`, sign in and choose Connect with Threads.

**With Compose instead:** put a reverse proxy with a trusted certificate in front of the `web` service and set
`BETTER_AUTH_URL` to the proxy's `https://` address ([deployment.md](deployment.md#6-reverse-proxy-and-https)).

**Troubleshooting**

- *Browser certificate warning:* run `mkcert -install` again and restart the browser; check the certificate was made for
  `docket.local`.
- *Connection refused or name not found:* check the hosts entry, that `pnpm dev:https` is running, and the port in the
  address. If Threads refuses the port, use 443 as described above.
- *Signed out after changing the address:* the sign-in cookie belongs to the host. Sign in again at the new address.
