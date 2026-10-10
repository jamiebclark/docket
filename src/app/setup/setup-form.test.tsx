import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ completeSetup: vi.fn() }));

import { SetupField } from "./setup-form";

const base = { name: "password", label: "Password", type: "password", autoComplete: "new-password", hint: "12–128 characters" };

describe("SetupField", () => {
  it("links the hint when there is no error", () => {
    const html = renderToStaticMarkup(<SetupField {...base} />);
    expect(html).toContain('aria-describedby="password-hint"');
    expect(html).toContain('id="password-hint"');
    expect(html).toContain("12–128 characters");
  });

  it("keeps the hint visible and links both ids when there is an error", () => {
    const html = renderToStaticMarkup(<SetupField {...base} error="Too short" />);
    expect(html).toContain('aria-describedby="password-hint password-error"');
    expect(html).toContain("12–128 characters");
    expect(html).toContain('id="password-error"');
  });

  it("has no describedby without hint or error", () => {
    const html = renderToStaticMarkup(<SetupField {...base} hint={undefined} />);
    expect(html).not.toContain("aria-describedby");
  });
});
