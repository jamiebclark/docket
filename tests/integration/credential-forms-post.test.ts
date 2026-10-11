/**
 * Forms that carry a secret must not fall back to a GET.
 *
 * Both of these submit through `onSubmit` and a client, not a server action. A form with no
 * `method` defaults to GET, so if the submit happens before React has attached its handler —
 * hydration still in flight, a chunk that failed to load, scripting turned off — the browser
 * navigates to `?email=…&password=…`. That writes the secret into the address bar, the
 * session history, the `Referer` of whatever loads next, and the server's access log.
 *
 * Observed, not theorised: submitting the login form on a dev build produced
 * `/login?email=demo%40localhost.test&password=…` with the handler never firing.
 *
 * `method="post"` does not make these work without JavaScript — the handler is still what
 * signs you in. It only decides where the credentials go when the fallback fires: a request
 * body rather than a URL. Forms posting non-secret content are left alone.
 *
 * `signup-form.tsx` needs no guard here: it uses `<form action={…}>`, a server action, which
 * posts by construction.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

const CREDENTIAL_FORMS = [
  {
    file: "src/app/login/login-form.tsx",
    carries: "the account password",
  },
  {
    file: "src/app/p/[projectSlug]/accounts/ConnectCredentialsForm.tsx",
    carries: "a provider app password (Bluesky)",
  },
] as const;

describe("forms that carry a secret", () => {
  for (const { file, carries } of CREDENTIAL_FORMS) {
    it(`${file} posts rather than falling back to GET (${carries})`, () => {
      const source = readFileSync(join(ROOT, file), "utf8");
      const opening = source.match(/<form[^>]*>/);
      expect(opening, `no <form> found in ${file}`).not.toBeNull();
      expect(opening![0]).toContain('method="post"');
    });
  }

  it("the signup form posts through a server action, so it needs no method", () => {
    const source = readFileSync(join(ROOT, "src/app/signup/signup-form.tsx"), "utf8");
    expect(source).toMatch(/<form\s+action=\{/);
  });
});
