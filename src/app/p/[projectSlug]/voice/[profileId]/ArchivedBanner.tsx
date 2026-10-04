"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { restoreVoiceAction } from "../actions";

export function ArchivedBanner({ slug, profileId, canManage }: { slug: string; profileId: string; canManage: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-amber-700 p-3 text-sm dark:border-amber-400">
      <p>This profile is archived. It is not offered when generating, and posts that used it keep their record.</p>
      {canManage ? (
        <Button
          variant="secondary"
          pending={pending}
          pendingLabel="Restoring…"
          onClick={() =>
            start(async () => {
              const r = await restoreVoiceAction(slug, { profileId });
              if (r.ok) router.refresh();
              else setError(r.message);
            })
          }
        >
          Restore
        </Button>
      ) : null}
      {error ? <p role="alert">Error: {error}</p> : null}
    </div>
  );
}
