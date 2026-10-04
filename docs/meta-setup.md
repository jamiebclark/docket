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

If localhost is refused, give your machine an HTTPS name. The steps are the same as for Threads, so follow
[Local HTTPS for Threads](#local-https-for-threads) and register `https://docket.local:3000/connect/callback` in Facebook Login → Settings.

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

## Threads

Threads uses its own app id and secret, separate from the Meta app above, but it lives in the same Meta app dashboard.
Live Threads connect, renewal and publishing are **verified with mocks only**. Items marked **unverified** have not been
confirmed against the live service.

### Threads: add the use case

1. In the [Meta for Developers](https://developers.facebook.com/apps) dashboard open your app (or create one) and add the
   **Access the Threads API** use case.
2. Under the use case's permissions, add the two Docket needs: `threads_basic` and `threads_content_publish`.
3. Open the use case's settings and copy the **Threads app ID** and **Threads app secret**. These are **not** the Meta
   App ID and App Secret from step 8: the Threads use case has its own pair.

### Threads: testers

While the app is in development mode only invited accounts can connect.

1. In **App roles → Roles** add each Threads account as a **Threads Tester**.
2. Each person accepts the invite in Threads under **Settings → Account → Website permissions**.

If Threads refuses the login, a missing acceptance is the first thing to check.

### Threads: redirect addresses

In the Threads use case's settings add `https://<host>/connect/callback` for production and
`https://docket.local:3000/connect/callback` for local use (see [Local HTTPS for Threads](#local-https-for-threads)).

- Threads refuses `http://` and `localhost` addresses. Docket checks this before sending you there and shows a reason and a link here.
- **Port (R8, unverified):** the dashboard may refuse a non-default port such as `:3000`. If it does, run Docket on 443 (with
  `sudo`, or a port forward from 443 to 3000) and register `https://docket.local/connect/callback` instead.
- **Uninstall and delete callback fields (R8, unverified):** the dashboard may insist on these. Docket builds no such endpoint;
  enter the deployment's base address (for example `https://docket.local:3000`).

### Threads: environment variables

| Variable | Meaning |
|---|---|
| `THREADS_APP_ID` | The Threads app ID. |
| `THREADS_APP_SECRET` | The Threads app secret. Set both or neither: one without the other is a startup error. |
| `THREADS_GRAPH_BASE` | Optional. Graph address for Threads. Default `https://graph.threads.com`. Must be `https` with no path. |

Leave `THREADS_APP_ID` and `THREADS_APP_SECRET` empty to switch Threads off.

### Threads: pasting a token instead (unverified, U2)

If the redirect flow cannot work, paste a token:

1. In the dashboard open the Threads use case and find the **User Token Generator** (**unverified (U2)**: its location may differ).
2. Generate a token for your tester account with `threads_basic` and `threads_content_publish`.
3. In Docket open Accounts, choose Threads and paste it.

Docket first tries to exchange it for a long-lived token, then to renew it, and otherwise saves it as it is with an estimated
expiry shown on the account. Whichever form is saved is encrypted; a token saved as it was pasted is treated as long-lived.

### Local HTTPS for Threads

This is the owner's chosen approach for local development (a hosts name and a trusted local certificate, not a tunnel).
Media still needs a public bucket: Threads fetches each image by URL ([storage.md](storage.md)).

1. **Hosts entry.** Add `127.0.0.1 docket.local` to your hosts file:
   - macOS and Linux: `/etc/hosts` (edit with `sudo`).
   - Windows: `C:\Windows\System32\drivers\etc\hosts` (edit as Administrator).
2. **mkcert.** Install [mkcert](https://github.com/FiloSottile/mkcert) (a developer tool you install; Docket does not depend on it), then:
   ```sh
   mkcert -install
   mkdir -p certificates
   mkcert -key-file certificates/docket.local-key.pem -cert-file certificates/docket.local.pem docket.local
   ```
   `certificates/` is git-ignored.
3. **Public address.** Set `BETTER_AUTH_URL=https://docket.local:3000` in `.env`.
4. **Start over HTTPS.** Run `pnpm dev:https`. It runs `next dev` with `--experimental-https`, your key and certificate, and `-H docket.local`.
5. **Register the callback.** Add `https://docket.local:3000/connect/callback` in the Threads use case (see above).
6. Open `https://docket.local:3000`, sign in and choose Connect with Threads.

**Troubleshooting**

- *Browser certificate warning:* run `mkcert -install` again and restart the browser; check the certificate was made for `docket.local`.
- *Connection refused or name not found:* check the hosts entry, that `pnpm dev:https` is running, and the port in the address.
  If Threads refuses the port, use 443 as described above.
- *Signed out after changing the address:* the sign-in cookie belongs to the host. Sign in again at `https://docket.local:3000`.
