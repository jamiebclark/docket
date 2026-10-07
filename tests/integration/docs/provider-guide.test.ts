import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const guide = readFileSync("docs/adding-a-provider.md", "utf8");
const source = ts.createSourceFile(
  "src/providers/types.ts",
  readFileSync("src/providers/types.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

function declaration(name: string): ts.Node {
  const found = source.statements.find(
    (s) => (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && s.name.text === name,
  );
  if (!found) throw new Error(`${name} not found in src/providers/types.ts`);
  return found;
}

/** Property and method names of every type literal or interface under `node`, including nested ones. */
function memberNames(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isPropertySignature(n) || ts.isMethodSignature(n)) && ts.isIdentifier(n.name)) names.push(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

/** The string-literal `kind` / `strategy` discriminants of a union. */
function discriminants(node: ts.Node, property: string): string[] {
  const values: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertySignature(n) && ts.isIdentifier(n.name) && n.name.text === property && n.type) {
      if (ts.isLiteralTypeNode(n.type) && ts.isStringLiteral(n.type.literal)) values.push(n.type.literal.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return values;
}

/** True when `name` appears inside an inline code span. */
function mentioned(name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("`[^`\\n]*(?<![\\w])" + escaped + "(?![\\w])[^`\\n]*`").test(guide);
}

const groups: Record<string, string[]> = {
  SocialProvider: memberNames(declaration("SocialProvider")),
  ProviderCapabilities: memberNames(declaration("ProviderCapabilities")),
  VideoCapabilities: memberNames(declaration("VideoCapabilities")),
  CustomCountingRule: memberNames(declaration("CustomCountingRule")),
  OAuthConnectGroup: memberNames(declaration("OAuthConnectGroup")),
  CredentialField: memberNames(declaration("CredentialField")),
  ConnectCandidate: memberNames(declaration("ConnectCandidate")),
  "StepResult kinds": discriminants(declaration("StepResult"), "kind"),
  "StepResult flags": ["credentialsExpired", "credentialsInvalid", "notBefore"],
  "ConnectStrategy strategies": discriminants(declaration("ConnectStrategy"), "strategy"),
};

describe("docs/adding-a-provider.md covers src/providers/types.ts", () => {
  it("finds the members it is meant to check", () => {
    expect(groups.SocialProvider).toEqual(
      expect.arrayContaining(["connectAccount", "needsRefresh", "refreshCredentials", "accountNotes", "stepFor", "defaultPublishLimit"]),
    );
    expect(groups.ProviderCapabilities).toEqual(expect.arrayContaining(["outputMimeType", "maxAltTextLength", "maxAspectRatio"]));
    expect(groups["StepResult kinds"]).toHaveLength(5);
    expect(groups["ConnectStrategy strategies"]).toHaveLength(3);
  });

  for (const [group, names] of Object.entries(groups)) {
    it(`mentions every ${group} member in backticks`, () => {
      const missing = [...new Set(names)].filter((n) => !mentioned(n));
      expect(missing).toEqual([]);
    });
  }

  it("mentions the generic changes G1 to G14 and G17", () => {
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17]) expect(guide, `G${i}`).toMatch(new RegExp(`\\bG${i}\\b`));
  });

  it("documents that exchangeCode receives state (G17)", () => {
    expect(guide).toMatch(/\|\s*G17\s*\|\s*exchangeCode receives state\s*\|\s*4\s*\|/);
    expect(guide).toMatch(/exchangeCode\(\{[^}]*\bstate\b[^}]*\}\)/);
  });

  it("has no 004 F5 contradictions", () => {
    expect(guide).not.toContain("stepFor(state, settings)");
    expect(guide).not.toMatch(/the next tick refreshes/i);
    expect(guide).not.toContain("blob.ipld()");
  });

  it("carries the refresh hold note", () => {
    expect(guide).toMatch(/refresh hold/i);
  });

  it("describes the X PKCE verifier as derived from state, never stored", () => {
    const x = guide.slice(guide.indexOf("## 16. Worked example: the `x` provider"));
    expect(x).toMatch(/HMAC-SHA256\(`X_CLIENT_SECRET`, "docket:x:pkce:v1:" \+ state\)/);
    expect(x).not.toMatch(/verifier is kept in/i);
    expect(x).not.toMatch(/reads the verifier from/i);
  });

  it("links to docs/limits.md and explains engine-side checks", () => {
    expect(guide).toContain("docs/limits.md");
    expect(guide).toMatch(/What the engine checks for you/);
  });
});
