# Contract: Internal interfaces (secrets, tokens, invitation delivery, startup)

## Secrets at rest: `src/server/crypto/secrets.ts` (FR-007, D16)

```ts
export function encryptSecret(plaintext: string, opts?: { aad?: string }): string;
export function decryptSecret(ciphertext: string, opts?: { aad?: string }): string; // throws SecretDecryptionError
export class SecretDecryptionError extends Error {}   // message: "Secret could not be decrypted"
```

- Format: `enc:v1:<kid>:<iv>:<tag>:<ct>`, each part base64url. `iv` is 12
  random bytes, `tag` is 16 bytes, `kid` is the hex of the first 8 bytes of
  `SHA-256("docket-kid:" ‖ key)`.
- The key comes from `getEnv().CREDENTIALS_ENCRYPTION_KEY` (32 bytes,
  validated at startup).
- `decryptSecret` throws `SecretDecryptionError` for a wrong prefix, an
  unknown version, an unknown kid, bad encoding, a wrong AAD, a tag mismatch
  (tamper) or a wrong key. The error **message, `cause` and stack carry no
  plaintext, key or ciphertext**.
- The module never logs.
- Required tests: round trip (incl. empty string and multibyte),
  ciphertext differs per call, tamper of each part, wrong key, unknown
  `v2`, unknown kid, AAD mismatch, and an error-text scan for the plaintext
  and key.

## Invitation tokens: `src/server/crypto/tokens.ts` (FR-026, D6)

```ts
export function generateInvitationToken(): { token: string; tokenHash: string }; // 32 bytes base64url, sha256 hex
export function hashInvitationToken(token: string): string;                       // sha256 hex
export function isWellFormedToken(token: unknown): token is string;               // /^[A-Za-z0-9_-]{43}$/
export function invitationUrl(token: string): string;                             // `${BETTER_AUTH_URL}/signup?token=${token}`
```

## Invitation delivery: `src/server/services/invitations/delivery.ts` (FR-027, D7)

```ts
export interface InvitationDeliveryInput {
  invitation: { id: string; email: string; role: Role; expiresAt: Date };
  project: { name: string; slug: string };
  inviter: { name: string; email: string };
  acceptUrl: string;            // plaintext URL; only ever passed to deliver() and returned once
  inviteeHasAccount: boolean;
}

export type InvitationDeliveryResult =
  | { kind: "in_app" }                                    // invitee sees it at /invitations + badge
  | { kind: "manual_link"; url: string; expiresAt: Date }; // inviter copies the link (shown once)

export interface InvitationDelivery {
  deliver(input: InvitationDeliveryInput): Promise<InvitationDeliveryResult>;
}

export const defaultInvitationDelivery: InvitationDelivery; // in_app if inviteeHasAccount, else manual_link
```

- The service gets the delivery by injection (default above), so tests can
  pass a fake. A future email delivery is another implementation.
- `deliver()` runs **after** the invitation transaction commits. If it
  throws, the invitation stays pending and the inviter is told to use
  Regenerate.

## Startup: `src/server/startup/index.ts` (D14)

```ts
export async function runStartup(): Promise<void>;
// 1. getEnv() — on failure print issues (names + reasons only), process.exit(1)
// 2. if MIGRATE_ON_START: migrate(db(DATABASE_URL_DIRECT ?? DATABASE_URL), { migrationsFolder: "./drizzle" }) — on failure log a fixed message + error code, exit(1)
// 3. if BOOTSTRAP_ADMIN_EMAIL: dal.install.bootstrapFirstUser(...) — "created" | "skipped (accounts exist)"; logs which, never the password
```

`src/instrumentation.ts`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartup } = await import("./server/startup");
    await runStartup();
  }
}
```

## Better Auth instance: `src/server/auth/auth.ts`

The configuration contract (all values are research-verified, F1–F12):

```ts
betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema, transaction: true }),
  advanced: { database: { generateId: "uuid" } },
  emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
  rateLimit: { enabled: true },                      // D5
  hooks: { before: createAuthMiddleware(gateBlockedPaths) }, // D2
  plugins: [
    organization({ ac, roles: { owner, admin, editor }, creatorRole: "owner",
                   invitationExpiresIn: env.INVITATION_TTL_DAYS * 86400 }),
    nextCookies(),                                   // last (U2)
  ],
});
```
