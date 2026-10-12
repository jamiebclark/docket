import { describe, expect, it } from "vitest";
import {
  EMAIL_CONFIRMATION_CODES,
  allSwitchesOffText,
  digestBeatsQuietText,
  emailConfirmationText,
  followsSwitchesText,
  immediateMeansText,
  noProjectsText,
  offKeepsBellText,
  onlyProblemsText,
  parseEmailConfirmation,
  pausedFailingText,
  pausedRejectedText,
  unavailableText,
  zoneDerivedText,
  zoneDerivedUtcText,
  zoneUnknownText,
} from "./text";

describe("sentences", () => {
  it("every sentence is present and non-empty", () => {
    const sentences = [
      onlyProblemsText(),
      followsSwitchesText(),
      offKeepsBellText(),
      digestBeatsQuietText(),
      immediateMeansText(30),
      unavailableText(),
      noProjectsText(),
      allSwitchesOffText(),
      pausedRejectedText(),
      pausedFailingText(),
      zoneDerivedText("America/New_York"),
      zoneDerivedUtcText(),
      zoneUnknownText(),
    ];
    for (const s of sentences) {
      expect(typeof s).toBe("string");
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it("immediateMeansText interpolates the interval", () => {
    expect(immediateMeansText(30)).toContain("30 seconds");
  });

  it("zoneDerivedText interpolates the zone", () => {
    expect(zoneDerivedText("Europe/Paris")).toContain("Europe/Paris");
  });
});

describe("parseEmailConfirmation", () => {
  it("parses every known code", () => {
    for (const code of EMAIL_CONFIRMATION_CODES) {
      expect(parseEmailConfirmation(code)).toBe(code);
    }
  });

  it("returns null for anything else", () => {
    expect(parseEmailConfirmation("bogus")).toBeNull();
    expect(parseEmailConfirmation(undefined)).toBeNull();
    expect(parseEmailConfirmation(42)).toBeNull();
    expect(parseEmailConfirmation(null)).toBeNull();
  });
});

describe("emailConfirmationText", () => {
  it("renders every confirmation code", () => {
    expect(emailConfirmationText("saved")).toBe("Email settings saved.");
    expect(emailConfirmationText("resumed")).toBe("Email resumed. You will get the next due message.");
    expect(emailConfirmationText("off")).toBe("Email is off. You will not be emailed about problems.");
    expect(emailConfirmationText("digest", { hour: "7 AM", zone: "America/New_York" })).toBe(
      "Switched to one email a day at 7 AM America/New_York.",
    );
    expect(emailConfirmationText("immediate")).toBe("Switched to immediate email.");
    expect(emailConfirmationText("project_off", { projectName: "Acme" })).toBe(
      "Acme problems will not be emailed. Your other projects still will.",
    );
  });

  it("renders a generic confirmation for an unparseable code", () => {
    expect(emailConfirmationText(null)).toBe("Email settings updated.");
  });
});
