import { describe, expect, it } from "vitest";
import { explainPinterest } from "./errors";

const SECRET = "secret-access-token-abcdef";

describe("explainPinterest", () => {
  it("names the stored board on a 404", () => {
    expect(explainPinterest(404, null, "Recipes", [])).toBe('Pinterest could not find the board "Recipes". Choose another board for this post.');
  });

  it("returns the fixed sentence for a 403", () => {
    expect(explainPinterest(403, null, "Recipes", [])).toBe("Pinterest refused permission for this pin.");
  });

  it("returns the fixed sentence for a 400", () => {
    expect(explainPinterest(400, null, "Recipes", [])).toBe("Pinterest refused the pin.");
  });

  it("names the status for any other 4xx", () => {
    expect(explainPinterest(422, null, "Recipes", [])).toBe("Pinterest refused the pin (HTTP 422).");
  });

  it("treats 5xx (and any other non-2xx) as ambiguous phrasing", () => {
    expect(explainPinterest(500, null, "Recipes", [])).toBe(
      "Pinterest answered with an error (HTTP 500) after the pin was sent. Check the board on Pinterest before retrying.",
    );
    expect(explainPinterest(599, null, "Recipes", [])).toBe(
      "Pinterest answered with an error (HTTP 599) after the pin was sent. Check the board on Pinterest before retrying.",
    );
  });

  it("appends a scrubbed Pinterest suffix only when a message came back", () => {
    expect(explainPinterest(400, null, "Recipes", [])).toBe("Pinterest refused the pin.");
    expect(explainPinterest(400, "Board is closed", "Recipes", [])).toBe("Pinterest refused the pin. (Pinterest: Board is closed)");
  });

  it("scrubs secrets and links from the appended message", () => {
    const message = `Token ${SECRET} rejected, see https://pinterest.com/help`;
    const result = explainPinterest(403, message, "Recipes", [SECRET]);
    expect(result).not.toContain(SECRET);
    expect(result).toContain("[redacted]");
    expect(result).toContain("[link]");
  });

  it("never consults a numeric code — only the HTTP status is read", () => {
    const withCode = explainPinterest(404, null, "Recipes", []);
    expect(withCode).not.toMatch(/\d{3,}/);
  });
});
