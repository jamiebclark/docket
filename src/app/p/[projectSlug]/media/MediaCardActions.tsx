"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { MediaView } from "@/server/services/media";
import { DeleteMediaDialog } from "./DeleteMediaDialog";
import { MediaEditDialog } from "./MediaEditDialog";

export function MediaCardActions({ slug, item }: { slug: string; item: MediaView }) {
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const [opened, setOpened] = useState(0);
  const label = item.originalFilename ?? "image";
  return (
    <div className="mt-1 flex gap-2">
      <Button variant="secondary" aria-label={`Edit ${label}`} onClick={() => setDialog("edit")}>
        Edit
      </Button>
      <Button variant="danger" aria-label={`Delete ${label}`} onClick={() => {
          setOpened((n) => n + 1);
          setDialog("delete");
        }}>
        Delete
      </Button>
      <MediaEditDialog key={item.id + item.altText + item.tags.join()} slug={slug} item={item} open={dialog === "edit"} onClose={() => setDialog(null)} />
      <DeleteMediaDialog key={opened} slug={slug} item={item} open={dialog === "delete"} onClose={() => setDialog(null)} />
    </div>
  );
}
