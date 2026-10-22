import { describe, expect, it } from "vitest";
import {
  ACTIVITY_KINDS,
  ACTIVITY_OUTCOMES,
  KIND_OUTCOME,
  OUTCOME_COUNT_NOUN,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  PROBLEM_OUTCOMES,
} from "./outcomes";

describe("the one vocabulary", () => {
  it("labels, tones and count nouns cover every outcome", () => {
    for (const outcome of ACTIVITY_OUTCOMES) {
      expect(OUTCOME_LABEL[outcome], outcome).toBeTruthy();
      expect(OUTCOME_TONE[outcome], outcome).toBeTruthy();
      expect(OUTCOME_COUNT_NOUN[outcome], outcome).toBeTruthy();
    }
  });

  it("pairs every kind with a known outcome", () => {
    for (const kind of ACTIVITY_KINDS) {
      expect(ACTIVITY_OUTCOMES).toContain(KIND_OUTCOME[kind]);
    }
  });
});

describe("the engagement outcome", () => {
  // 020 feedback: "New replies" was the badge for a class that also holds comments, mentions and
  // DMs, and it sat directly above a message reading "1 new comment". Somebody got an email about a
  // comment, read "reply", and went looking for a reply that did not exist.
  it("does not call the whole class replies", () => {
    expect(OUTCOME_LABEL.engagement.toLowerCase()).not.toContain("repl");
    expect(OUTCOME_COUNT_NOUN.engagement.one.toLowerCase()).not.toContain("repl");
    expect(OUTCOME_COUNT_NOUN.engagement.many.toLowerCase()).not.toContain("repl");
  });

  it("is short enough to sit in a badge beside the other labels", () => {
    const longest = Math.max(...ACTIVITY_OUTCOMES.map((o) => OUTCOME_LABEL[o].length));
    expect(OUTCOME_LABEL.engagement.length).toBeLessThanOrEqual(longest);
  });

  // The Activity screen's "problems" preset must keep meaning what it means
  // (077 contracts/vocabulary.md §2), and the email subject counts on this too.
  it("is never a problem", () => {
    expect(PROBLEM_OUTCOMES).not.toContain("engagement");
    expect(OUTCOME_COUNT_NOUN.engagement.one.toLowerCase()).not.toContain("problem");
  });
});

describe("count nouns", () => {
  it("read as a noun after a number, which the state labels do not", () => {
    // "1 Needs your decision" is why OUTCOME_COUNT_NOUN exists separately from OUTCOME_LABEL.
    expect(`1 ${OUTCOME_COUNT_NOUN.ambiguous.one}`).toBe("1 post to decide on");
    expect(`2 ${OUTCOME_COUNT_NOUN.failed.many}`).toBe("2 failed posts");
    expect(`1 ${OUTCOME_COUNT_NOUN.needs_reauth.one}`).toBe("1 account to reconnect");
  });

  it("gives every outcome a distinct singular and plural", () => {
    for (const outcome of ACTIVITY_OUTCOMES) {
      const { one, many } = OUTCOME_COUNT_NOUN[outcome];
      expect(one, outcome).not.toBe(many);
    }
  });
});
