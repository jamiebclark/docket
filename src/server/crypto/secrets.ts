import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getEnv } from "@/server/env";

export class SecretDecryptionError extends Error {
  constructor() {
    super("Secret could not be decrypted");
    this.name = "SecretDecryptionError";
  }
}

const PREFIX = "enc";
const VERSION = "v1";

function getKey(): Buffer {
  const raw = getEnv().CREDENTIALS_ENCRYPTION_KEY;
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
}

function keyId(key: Buffer): string {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from("docket-kid:"), key]))
    .digest()
    .subarray(0, 8)
    .toString("hex");
}

const b64 = (b: Buffer) => b.toString("base64url");

export function encryptSecret(plaintext: string, opts?: { aad?: string }): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (opts?.aad !== undefined) cipher.setAAD(Buffer.from(opts.aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [PREFIX, VERSION, keyId(key), b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(":");
}

export function decryptSecret(ciphertext: string, opts?: { aad?: string }): string {
  try {
    const parts = ciphertext.split(":");
    const [prefix, version, kid, ivPart, tagPart, ctPart] = parts;
    if (
      parts.length !== 6 ||
      prefix !== PREFIX ||
      version !== VERSION ||
      ivPart === undefined ||
      tagPart === undefined ||
      ctPart === undefined
    ) {
      throw new Error("shape");
    }
    const key = getKey();
    if (kid !== keyId(key)) throw new Error("kid");
    const iv = Buffer.from(ivPart, "base64url");
    const tag = Buffer.from(tagPart, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("shape");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    if (opts?.aad !== undefined) decipher.setAAD(Buffer.from(opts.aad, "utf8"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Deliberately drop the original error: it must not carry key or ciphertext.
    throw new SecretDecryptionError();
  }
}
