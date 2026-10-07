"use client";

import { UploadPanel } from "@/components/media/upload/UploadPanel";
import type { LibraryLimits } from "@/server/media/limits";

/** The library's upload area: the shared panel with the limits the server serves. */
export function UploadDropzone({ slug, limits }: { slug: string; limits: LibraryLimits }) {
  return <UploadPanel slug={slug} limits={limits} />;
}
