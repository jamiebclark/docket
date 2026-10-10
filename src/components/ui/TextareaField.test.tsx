import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextareaField } from "./TextareaField";

describe("TextareaField", () => {
  it("renders a visible label by htmlFor, sr-only when hideLabel", () => {
    const html = renderToStaticMarkup(<TextareaField id="x" label="Label" />);
    expect(html).toContain('<label for="x"');
    expect(html).not.toContain("sr-only");
    const hidden = renderToStaticMarkup(<TextareaField id="x" label="Label" hideLabel />);
    expect(hidden).toContain("sr-only");
  });

  it("renders a hint only when set, at ${id}-hint", () => {
    const withoutHint = renderToStaticMarkup(<TextareaField id="x" label="L" />);
    expect(withoutHint).not.toContain("x-hint");
    const withHint = renderToStaticMarkup(<TextareaField id="x" label="L" hint="Help" />);
    expect(withHint).toContain('<p id="x-hint"');
    expect(withHint).toContain("Help");
  });

  it("builds aria-describedby from hint, counter and the always-present error id", () => {
    expect(renderToStaticMarkup(<TextareaField id="x" label="L" />)).toContain('aria-describedby="x-error"');
    expect(renderToStaticMarkup(<TextareaField id="x" label="L" hint="h" />)).toContain(
      'aria-describedby="x-hint x-error"',
    );
    expect(renderToStaticMarkup(<TextareaField id="x" label="L" hint="h" counter="1/2" />)).toContain(
      'aria-describedby="x-hint x-count x-error"',
    );
  });

  it("always reserves the aria-live error line", () => {
    const noError = renderToStaticMarkup(<TextareaField id="x" label="L" />);
    expect(noError).toContain('aria-live="polite"');
    expect(noError).toContain('<p id="x-error"');
    const withError = renderToStaticMarkup(<TextareaField id="x" label="L" error="Bad" />);
    expect(withError).toContain("Bad");
  });

  it("sets aria-invalid only with an error, and lets a caller override win", () => {
    expect(renderToStaticMarkup(<TextareaField id="x" label="L" />)).not.toContain('aria-invalid="');
    expect(renderToStaticMarkup(<TextareaField id="x" label="L" error="Bad" />)).toContain('aria-invalid="true"');
    expect(
      renderToStaticMarkup(<TextareaField id="x" label="L" error="Bad" aria-invalid={false} />),
    ).toContain('aria-invalid="false"');
  });

  it("puts the counter paragraph between the control and the error line, with id ${id}-count", () => {
    const html = renderToStaticMarkup(<TextareaField id="x" label="L" counter="3/10" />);
    expect(html).toContain('<p id="x-count"');
    expect(html).toContain("3/10");
    expect(html.indexOf('<p id="x-count"')).toBeLessThan(html.indexOf('<p id="x-error"'));
    expect(html.indexOf("</textarea>")).toBeLessThan(html.indexOf('<p id="x-count"'));
  });

  it("adds font-mono only when mono is set", () => {
    expect(renderToStaticMarkup(<TextareaField id="x" label="L" />)).not.toContain("font-mono");
    expect(renderToStaticMarkup(<TextareaField id="x" label="L" mono />)).toContain("font-mono");
  });

  it("includes controlStyles' own classes without restating them", () => {
    const html = renderToStaticMarkup(<TextareaField id="x" label="L" />);
    expect(html).toContain("rounded-lg");
    expect(html).toContain("field-sizing-content");
  });

  it("carries rows, min-height, max-height and field-sizing-content in server-rendered markup", () => {
    const html = renderToStaticMarkup(
      <TextareaField id="x" label="L" minRows={3} maxRows={20} defaultValue={"a very long saved value\n".repeat(30)} />,
    );
    expect(html).toContain('rows="3"');
    expect(html).toMatch(/min-height:\s*calc\(3\.75rem/);
    expect(html).toMatch(/max-height:\s*calc\(25rem/);
    expect(html).toContain("field-sizing-content");
  });

  it("passes name, maxLength, required, readOnly and placeholder through", () => {
    const html = renderToStaticMarkup(
      <TextareaField
        id="x"
        label="L"
        name="field-name"
        maxLength={100}
        required
        readOnly
        placeholder="Type here"
      />,
    );
    expect(html).toContain('name="field-name"');
    expect(html).toContain('maxLength="100"');
    expect(html).toContain('required=""');
    expect(html).toContain('readOnly=""');
    expect(html).toContain('placeholder="Type here"');
  });
});
