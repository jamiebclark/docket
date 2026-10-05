import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EMPTY_VOICE_CONTENT } from "@/lib/validation/voice";
import { scopeOrNotFound } from "../scope";
import { VoiceEditor } from "../VoiceEditor";

export const metadata: Metadata = { title: "New voice profile" };
export const dynamic = "force-dynamic";

export default async function NewVoicePage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  const scope = await scopeOrNotFound(projectSlug);
  if (!scope.can({ voice: ["manage"] })) notFound();
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">New voice profile</h1>
      <VoiceEditor
        slug={projectSlug}
        canManage
        initialName=""
        initialContent={EMPTY_VOICE_CONTENT}
        accounts={[]}
      />
    </section>
  );
}
