import { describe, expect, it } from "vitest";
import { listProviders } from "@/providers/registry";
import type { CredentialField } from "@/providers/types";

// A stored credential exists so the server can reauthenticate itself. Prefilling one into a form
// would send it back to the browser on every page view — and an app password, unlike a refresh
// token, never expires, so a leak stays open until it is revoked at the platform. `defaultValue`
// already carries "never on a secret field"; `prefillOnReconnect` must honour the same rule, and
// the form must start every secret empty whatever a provider declares.
const credentialFields = (): { provider: string; field: CredentialField }[] =>
  listProviders().flatMap((p) =>
    p.connect.strategy === "oauth" ? [] : p.connect.fields.map((field) => ({ provider: p.key, field })),
  );

describe("credential fields", () => {
  it("finds fields to check", () => {
    expect(credentialFields().length).toBeGreaterThan(0);
  });

  it("never prefill a secret from the account", () => {
    const offenders = credentialFields()
      .filter(({ field }) => field.secret && field.prefillOnReconnect !== undefined)
      .map(({ provider, field }) => `${provider}.${field.name}`);
    expect(offenders, `${offenders.join(", ")} would render a stored secret into the form`).toEqual([]);
  });

  it("never give a secret a default value either", () => {
    const offenders = credentialFields()
      .filter(({ field }) => field.secret && field.defaultValue !== undefined)
      .map(({ provider, field }) => `${provider}.${field.name}`);
    expect(offenders).toEqual([]);
  });

  it("only prefill from a source the account view actually exposes", () => {
    const offenders = credentialFields()
      .filter(({ field }) => field.prefillOnReconnect !== undefined && field.prefillOnReconnect !== "displayName")
      .map(({ provider, field }) => `${provider}.${field.name}`);
    expect(offenders).toEqual([]);
  });
});
