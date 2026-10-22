import { describe, expect, it } from "vitest";
import { engagementItemsMessage, engagementKindPhrase, isEngagementItemKind, joinPhrases } from "./kinds";

describe("engagementItemsMessage", () => {
  it("names the kind, so a comment never reads as a reply (020 feedback)", () => {
    expect(engagementItemsMessage({ comment: 1 })).toBe("1 new comment");
    expect(engagementItemsMessage({ reply: 1 })).toBe("1 new reply");
    expect(engagementItemsMessage({ mention: 1 })).toBe("1 new mention");
    expect(engagementItemsMessage({ direct_message: 1 })).toBe("1 new direct message");
  });

  it("pluralises each kind on its own count", () => {
    expect(engagementItemsMessage({ reply: 3 })).toBe("3 new replies");
    expect(engagementItemsMessage({ direct_message: 2 })).toBe("2 new direct messages");
  });

  it("carries 'new' once, at the front, where it governs the whole list", () => {
    expect(engagementItemsMessage({ comment: 2, mention: 1 })).toBe("2 new comments and 1 mention");
  });

  it("lists in the declared order, not by count, so the same mix always reads the same", () => {
    expect(engagementItemsMessage({ mention: 9, reply: 1 })).toBe("1 new reply and 9 mentions");
    expect(engagementItemsMessage({ reply: 1, comment: 2, mention: 3 })).toBe("1 new reply, 2 comments and 3 mentions");
  });

  it("ignores kinds with nothing in them", () => {
    expect(engagementItemsMessage({ reply: 0, comment: 1 })).toBe("1 new comment");
  });
});

describe("engagementKindPhrase", () => {
  it("agrees the count with its noun", () => {
    expect(engagementKindPhrase("reply", 1)).toBe("1 reply");
    expect(engagementKindPhrase("reply", 2)).toBe("2 replies");
  });
});

describe("joinPhrases", () => {
  it("joins one, two and three the one way", () => {
    expect(joinPhrases(["a"])).toBe("a");
    expect(joinPhrases(["a", "b"])).toBe("a and b");
    expect(joinPhrases(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("isEngagementItemKind", () => {
  it("accepts the four kinds and nothing else", () => {
    expect(isEngagementItemKind("direct_message")).toBe(true);
    expect(isEngagementItemKind("dm")).toBe(false);
    expect(isEngagementItemKind(null)).toBe(false);
  });
});
