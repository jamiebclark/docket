import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/p/x/calendar" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import { LeftNav, NAV_SECTIONS } from "../../../src/components/shell/LeftNav";
import { countNeedsDecision } from "../../../src/server/services/failures";
import { closeDb } from "../../helpers/db";
import { outcomeTarget } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

describe("Failures nav entry", () => {
  it("comes after Review and shows the ambiguous count only when above zero", () => {
    const slugs = NAV_SECTIONS.map((s) => s.slug);
    expect(slugs.indexOf("failures")).toBe(slugs.indexOf("review") + 1);
    expect(renderToStaticMarkup(createElement(LeftNav, { projectSlug: "x", failuresCount: 2 }))).toContain("Failures (2)");
    const zero = renderToStaticMarkup(createElement(LeftNav, { projectSlug: "x", failuresCount: 0 }));
    expect(zero).toContain(">Failures<");
    expect(zero).not.toContain("Failures (");
  });

  it("counts ambiguous targets only", async () => {
    const env = await postsEnv();
    await outcomeTarget(env, "fatal");
    expect(await countNeedsDecision(env.scope)).toBe(0);
    await outcomeTarget(env, "ambiguous");
    expect(await countNeedsDecision(env.scope)).toBe(1);
  });

  it("uses one count query and loads no list", async () => {
    const env = await postsEnv();
    await outcomeTarget(env, "ambiguous");
    const spies = {
      list: vi.spyOn(env.scope.targets, "listAttention"),
      count: vi.spyOn(env.scope.targets, "countAttention"),
      attempts: vi.spyOn(env.scope.attempts, "listForTargets"),
    };
    await countNeedsDecision(env.scope);
    expect(spies.count).toHaveBeenCalledTimes(1);
    expect(spies.list).not.toHaveBeenCalled();
    expect(spies.attempts).not.toHaveBeenCalled();
  });
});
