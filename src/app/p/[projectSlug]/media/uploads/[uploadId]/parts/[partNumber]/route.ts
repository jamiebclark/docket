import { NextResponse } from "next/server";
import { forProject } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { uploadPartViaApp } from "@/server/services/uploads";

export const runtime = "nodejs";

type Params = { projectSlug: string; uploadId: string; partNumber: string };

/** Fallback transport (`MEDIA_UPLOAD_TRANSPORT=via_app`): one chunk is one multipart part. The body is never logged. */
export async function PUT(request: Request, { params }: { params: Promise<Params> }) {
  const { projectSlug, uploadId, partNumber } = await params;
  const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const scope = await forProject(await getSession(), projectSlug);
    const header = request.headers.get("content-length");
    const result = await uploadPartViaApp(scope, {
      uploadId,
      partNumber: Number(partNumber),
      contentLength: header !== null && /^\d+$/.test(header) ? Number(header) : null,
      readBody: () => request.arrayBuffer(),
    });
    if (result.ok) return new NextResponse(null, { status: 204 });
    return NextResponse.json(
      { error: result.error, ...(result.message ? { message: result.message } : {}) },
      { status: result.status },
    );
  } catch (error) {
    // No session, a non-member, a viewer, someone else's session and a malformed id all look the same.
    if (error instanceof Error && ["NotFoundError", "ForbiddenError", "ZodError"].includes(error.name)) return notFound();
    throw error;
  }
}
