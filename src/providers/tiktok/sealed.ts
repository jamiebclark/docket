import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const KEY_LABEL = "docket:tiktok:upload-url:v1";

const keyFor = (secret: string): Buffer => createHmac("sha256", secret).update(KEY_LABEL).digest();

/** P25: AES-256-GCM, a random IV and AAD `<target id>:<publish_id>`. Output is `iv.ciphertext.tag`, base64url. */
export function sealUploadUrl(url: string, secret: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map((b) => b.toString("base64url")).join(".");
}

/** Null when the seal cannot be opened: tampered, a different AAD, or a rotated secret. Never throws. */
export function openUploadUrl(sealed: string, secret: string, aad: string): string | null {
  try {
    const parts = sealed.split(".");
    if (parts.length !== 3) return null;
    const [iv, body, tag] = parts.map((p) => Buffer.from(p, "base64url")) as [Buffer, Buffer, Buffer];
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
