import { describe, expect, it } from "vitest";
import { isStartRefusal, jobFailureText, limitFailureText, limitWaitText, lostUploadText, partTimeoutText, sanitiseMessage, startRefusalText } from "./video-errors";

describe("start refusals (D8)", () => {
  it.each([
    ["UnsupportedContentType", "it is not an MP4 file Bluesky accepts"],
    ["VideoTooLarge", "it is over Bluesky's 300 MB limit"],
    ["VideoTooLong", "Bluesky's limit is lower than expected"],
    ["BadAspectRatio", "Bluesky does not accept its shape"],
    ["UploadForbidden", "must verify their email address first"],
  ])("explains %s", (code, phrase) => {
    expect(isStartRefusal(code)).toBe(true);
    const text = startRefusalText(code, "nope");
    expect(text).toContain(phrase);
    expect(text).toContain(`(${code}: nope). Nothing was published.`);
  });
  it("drops the colon when there is no message", () => {
    expect(startRefusalText("VideoTooLarge", "")).toContain("(VideoTooLarge). Nothing");
  });
  it("does not treat other codes as start refusals", () => {
    expect(isStartRefusal("DailyLimitExceeded")).toBe(false);
    expect(isStartRefusal("toString")).toBe(false);
    expect(isStartRefusal(undefined)).toBe(false);
  });
});

describe("job failures (D8)", () => {
  it.each([
    ["validation_failure", "Bluesky found the file invalid"],
    ["encoding_failure", "could not process the file's encoding"],
    ["pds_upload_failure", "try again later"],
    ["pds_upload_unsupported_blob_size", "self-hosted servers"],
    ["generic_failure", "Bluesky could not process the video ("],
  ])("explains %s", (code, phrase) => {
    const text = jobFailureText(code, "m");
    expect(text).toContain(phrase);
    expect(text).toContain(`${code}: m)`);
    expect(text.endsWith("Nothing was published.")).toBe(true);
  });
  it("handles an unknown code and none", () => {
    expect(jobFailureText("weird", "x")).toBe("Bluesky could not process the video (weird: x). Nothing was published.");
    expect(jobFailureText(null, null)).toBe("Bluesky could not process the video (no code). Nothing was published.");
  });
});

describe("limit and loss texts", () => {
  it("uses Bluesky's message or the default", () => {
    expect(limitWaitText("Daily limit reached.")).toBe("Daily limit reached. Docket checks again in an hour; nothing was uploaded.");
    expect(limitWaitText(undefined)).toBe("Bluesky's daily video upload limit has been reached for this account. Docket checks again in an hour; nothing was uploaded.");
    expect(limitFailureText(null)).toContain("after a day of hourly checks; nothing was published.");
  });
  it("names the code of a lost upload and the setting of a timeout", () => {
    expect(lostUploadText("UploadNotFound")).toBe("Bluesky lost the upload before it finished (UploadNotFound); nothing was published.");
    expect(partTimeoutText(2, 3)).toContain("part 2 of 3");
    expect(partTimeoutText(2, 3)).toContain("SCHEDULER_PROVIDER_TIMEOUT_SECONDS");
  });
});

describe("sanitiseMessage (P17)", () => {
  it("scrubs every secret, control characters and length", () => {
    const out = sanitiseMessage("bad tok-123\u0000\nand jwt.abc.def here", ["tok-123", "jwt.abc.def"]);
    expect(out).toBe("bad [redacted] and [redacted] here");
    expect(sanitiseMessage("x".repeat(500)).length).toBe(200);
    expect(sanitiseMessage(undefined)).toBe("");
  });
  it("scrubs secrets inside every message built from a reply", () => {
    expect(startRefusalText("UploadForbidden", "token SECRET1", ["SECRET1"])).not.toContain("SECRET1");
    expect(jobFailureText("generic_failure", "SECRET1", ["SECRET1"])).not.toContain("SECRET1");
    expect(limitWaitText("SECRET1", ["SECRET1"])).not.toContain("SECRET1");
  });
});
