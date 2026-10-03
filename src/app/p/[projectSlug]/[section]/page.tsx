import { notFound } from "next/navigation";
import type { Metadata } from "next";

const PLACEHOLDERS: Record<string, string> = {
  calendar: "Calendar",
  posts: "Posts",
  generate: "Generate",
  jobs: "Jobs",
  review: "Review",
  media: "Media",
  accounts: "Accounts",
  voice: "Voice",
};

type Props = { params: Promise<{ projectSlug: string; section: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { section } = await params;
  const title = PLACEHOLDERS[section];
  return title ? { title } : {};
}

export default async function SectionPlaceholder({ params }: Props) {
  const { section } = await params;
  const title = Object.hasOwn(PLACEHOLDERS, section) ? PLACEHOLDERS[section] : undefined;
  if (!title) notFound();
  return (
    <section>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2">{title} is coming in a later release.</p>
    </section>
  );
}
