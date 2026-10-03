import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("hex");
let currentKey = keyA;

vi.mock("@/server/env", () => ({
  getEnv: () => ({ CREDENTIALS_ENCRYPTION_KEY: currentKey }),
}));

import { SecretDecryptionError, decryptSecret, encryptSecret } from "./secrets";

function fail(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected throw");
}

describe("secrets", () => {
  beforeEach(() => {
    currentKey = keyA;
  });

  it.each(["hunter2", "", "héllo 🔐 世界"])("round-trips %j", (plain) => {
    const ct = encryptSecret(plain);
    expect(ct.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(ct)).toBe(plain);
  });

  it("produces different ciphertext per call", () => {
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });

  it("detects tampering in every part", () => {
    const parts = encryptSecret("secret-value").split(":");
    for (let i = 2; i < parts.length; i++) {
      const copy = [...parts];
      const p = copy[i];
      copy[i] = (p[0] === "A" ? "B" : "A") + p.slice(1);
      expect(() => decryptSecret(copy.join(":"))).toThrow(SecretDecryptionError);
    }
  });

  it("rejects the wrong key", () => {
    const ct = encryptSecret("secret-value");
    currentKey = keyB;
    expect(() => decryptSecret(ct)).toThrow(SecretDecryptionError);
  });

  it("rejects unknown version and unknown kid and bad shapes", () => {
    const ct = encryptSecret("secret-value");
    expect(() => decryptSecret(ct.replace("enc:v1:", "enc:v2:"))).toThrow(SecretDecryptionError);
    const parts = ct.split(":");
    parts[2] = "0000000000000000";
    expect(() => decryptSecret(parts.join(":"))).toThrow(SecretDecryptionError);
    expect(() => decryptSecret("plain")).toThrow(SecretDecryptionError);
    expect(() => decryptSecret("enc:v1:a:b")).toThrow(SecretDecryptionError);
  });

  it("binds AAD", () => {
    const ct = encryptSecret("secret-value", { aad: "row-1" });
    expect(decryptSecret(ct, { aad: "row-1" })).toBe("secret-value");
    expect(() => decryptSecret(ct, { aad: "row-2" })).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(ct)).toThrow(SecretDecryptionError);
  });

  it("leaks nothing in error text", () => {
    const plain = "super-secret-plaintext";
    const ct = encryptSecret(plain);
    currentKey = keyB;
    const err = fail(() => decryptSecret(ct));
    const text = [err.message, String(err.cause ?? ""), err.stack ?? ""].join("\n");
    expect(err.message).toBe("Secret could not be decrypted");
    for (const needle of [plain, keyA, keyB, ct, ...ct.split(":").slice(3)]) {
      expect(text).not.toContain(needle);
    }
  });

  it("never logs", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const ct = encryptSecret("x");
    decryptSecret(ct);
    try {
      decryptSecret("bad");
    } catch {}
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });
});
