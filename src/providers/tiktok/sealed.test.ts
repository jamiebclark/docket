import { describe, expect, it } from "vitest";
import { openUploadUrl, sealUploadUrl } from "./sealed";

const url = "https://upload.tiktok.test/v/abc?upload_id=XYZ&sig=SECRET";
const aad = "target-1:v_pub_1";

describe("sealed upload address (P25)", () => {
  it("round trips and never shows the address", () => {
    const sealed = sealUploadUrl(url, "client-secret", aad);
    expect(sealed).not.toContain("upload");
    expect(sealed).not.toContain("SECRET");
    expect(openUploadUrl(sealed, "client-secret", aad)).toBe(url);
  });
  it("seals differently each time", () => {
    expect(sealUploadUrl(url, "s", aad)).not.toBe(sealUploadUrl(url, "s", aad));
  });
  it("does not open with another AAD", () => {
    expect(openUploadUrl(sealUploadUrl(url, "s", aad), "s", "target-2:v_pub_1")).toBeNull();
  });
  it("does not open after the secret rotates", () => {
    expect(openUploadUrl(sealUploadUrl(url, "old", aad), "new", aad)).toBeNull();
  });
  it("returns null for junk", () => {
    expect(openUploadUrl("nonsense", "s", aad)).toBeNull();
    expect(openUploadUrl("a.b.c", "s", aad)).toBeNull();
  });
});
