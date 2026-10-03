import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/session";
import * as projects from "@/server/services/projects";
import * as setup from "@/server/services/setup";
import { decideAnonymousRedirect, decideRootRedirect } from "./root-redirect";

export const metadata: Metadata = { title: "Docket" };
export const dynamic = "force-dynamic";

/** "/" sends a signed-in user to their remembered, earliest or a new project (FR-018). */
export default async function Home() {
  const session = await getSession();
  if (!session) redirect(decideAnonymousRedirect(await setup.isAvailable()));
  const [mine, jar] = await Promise.all([projects.listMine(session), cookies()]);
  redirect(decideRootRedirect(jar.get("docket_last_project")?.value, mine));
}
