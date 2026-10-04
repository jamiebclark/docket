import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { fieldErrorsFromZod, type ErrorCode } from "@/lib/action-result";
import { forProject } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as posts from "@/server/services/posts";

const HEADERS = { "Cache-Control": "no-store" };

const respond = (status: number, body: unknown) => NextResponse.json(body, { status, headers: HEADERS });
const notFound = () => respond(404, { ok: false, error: "not_found" satisfies ErrorCode });

/** Live counts and issues for composer state (contracts/ui.md). Never says which of session, membership or id was wrong. */
export async function POST(request: Request, { params }: { params: Promise<{ projectSlug: string }> }) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return respond(415, { ok: false, error: "validation", message: "Send JSON." });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(400, { ok: false, error: "validation", fieldErrors: { form: "The request is not valid JSON." } });
  }
  try {
    const { projectSlug } = await params;
    const scope = await forProject(await getSession(), projectSlug);
    return respond(200, { ok: true, data: await posts.checkComposition(scope, body) });
  } catch (error) {
    if (error instanceof ZodError) {
      return respond(400, { ok: false, error: "validation", fieldErrors: fieldErrorsFromZod(error) });
    }
    if (error instanceof Error && (error.name === "NotFoundError" || error.name === "ForbiddenError")) return notFound();
    throw error;
  }
}
