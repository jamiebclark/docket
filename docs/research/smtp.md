# SMTP — verified facts

Checked 2026-10-12 against the official Nodemailer documentation and RFC 8058. Written to close
`NEEDS RESEARCH: SMTP` in `src/server/mail/smtp.ts` and `src/server/mail/types.ts`; every claim below
has a source and none of it is from memory.

| Package | Version | Notes |
|---|---|---|
| nodemailer | 10.1.0 | the only transport; chosen because constitution VI forbids hand-rolling an SMTP client or shelling out to a mail binary (decision E5) |
| @types/nodemailer | 8.0.2 | dev dependency; nodemailer ships no types of its own |

## Transport security and ports

Sources: [SMTP transport](https://nodemailer.com/smtp), [Nodemailer](https://nodemailer.com/)

- **Default port is 587, or 465 when `secure: true`.** Docket therefore leaves `port` unset when the
  operator does, rather than inventing a default of its own.
- **`secure: true` means TLS from the moment the socket opens** (implicit TLS, the `smtps:` style,
  conventionally port 465). If `secure` is left unset and the port is 465, nodemailer infers `true`.
- **`secure: false` does not mean plaintext.** On 587 or 25 nodemailer performs an opportunistic
  STARTTLS upgrade whenever the server advertises it, unless `ignoreTLS: true` is set.
- **`requireTLS: true` demands the STARTTLS upgrade** — if the server does not offer STARTTLS the send
  fails rather than continuing unencrypted.

### How `SMTP_SECURITY` maps onto those options

| `SMTP_SECURITY` | `secure` | `requireTLS` | `ignoreTLS` | Meaning |
|---|---|---|---|---|
| `tls` | `true` | — | — | implicit TLS from connect, the 465 style |
| `starttls` | `false` | `true` | — | plaintext connect, then a **mandatory** STARTTLS upgrade; fails if unavailable |
| `none` | `false` | `false` | `true` | no TLS at all — only sensible for a mail server on localhost or a trusted private network |
| unset | `false` | `false` | `false` | nodemailer's own behaviour: opportunistic STARTTLS when offered |

`none` is deliberately explicit rather than the default: an operator has to ask for an unencrypted
session, and `starttls` is the mode that *guarantees* encryption on 587.

## Outcome classification

Source: [Error reference](https://nodemailer.com/errors)

On success `sendMail()` resolves with an info object carrying `accepted`, `rejected`, `response`,
`responseCode` and `messageId`. A send whose recipient lands in `rejected` is **not** a success even
though the promise resolved — Docket checks `accepted` before reporting `sent`.

Errors carry `code`, `responseCode`, `response` and `command`. The split that matters:

- **5xx `responseCode` is permanent** — it will not succeed unchanged (535 bad credentials, 550
  mailbox unavailable). Maps to `rejected`, which pauses sending at once (N61).
- **4xx `responseCode` is temporary** — may succeed on retry (421 service unavailable, 454 temporary
  authentication failure). Maps to `failed`.

| nodemailer `code` | Docket `MailFailureReason` | Why |
|---|---|---|
| `EAUTH` | `refused` | credentials or mechanism rejected |
| `ETIMEDOUT` | `timed_out` | connection, greeting, upgrade or socket timeout |
| `ECONNECTION`, `EDNS` | `connect_failed` | never reached a server, or the host did not resolve |
| `ESOCKET` | `connect_failed` | socket-level failure during the exchange |
| `ETLS` | `tls_failed` | TLS setup or the STARTTLS upgrade failed |
| `EENVELOPE`, `EMESSAGE` | see note | envelope/content rejection — permanent when `responseCode` is 5xx, else `failed` |
| anything else | `internal` | Docket's own fault until shown otherwise |

`EAUTH` is classified `refused` rather than permanent-`rejected` on purpose: a rotated or
briefly-wrong password should pause and retry, not look like a mailbox that will never accept mail.

## One-click unsubscribe headers

Source: [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html)

Two headers, exactly:

```
List-Unsubscribe: <https://host/api/email/unsubscribe?t=TOKEN>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

- `List-Unsubscribe` **MUST contain one HTTPS URI** (it may additionally carry non-HTTP URIs such as
  `mailto:`). The URI must by itself identify the recipient and the list.
- `List-Unsubscribe-Post` **MUST be exactly** the single pair `List-Unsubscribe=One-Click`.
- The mail client unsubscribes with an **HTTPS POST** whose body is `List-Unsubscribe=One-Click`,
  sent as `application/x-www-form-urlencoded` or `multipart/form-data`.

Two consequences for Docket:

1. **The headers are attached only when the URI is `https:`.** `BETTER_AUTH_URL` is routinely
   `http://localhost:3000` in development, and an `http:` URI in `List-Unsubscribe` is not
   RFC-conformant, so the headers are omitted there rather than emitted wrong. The unsubscribe *link*
   in the body is unaffected and still works.
2. **DKIM is the operator's job.** RFC 8058 requires the message to carry a valid DKIM signature with
   both header names in the signature's `h=` tag. Docket does not sign mail — signing belongs to the
   mail server — so this is documented in `docs/deployment.md` alongside SPF and DMARC rather than
   implemented here, consistent with the entry's out-of-scope list.
