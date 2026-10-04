"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { uploadMediaAction } from "./actions";

type Row = { id: number; name: string; state: "uploading" | "accepted" | "rejected"; reason?: string };

/** Files go up one at a time; each gets its own row so a rejection never hides the others. */
export function UploadDropzone({ slug, maxMegabytes }: { slug: string; maxMegabytes: number }) {
  const input = useRef<HTMLInputElement>(null);
  const next = useRef(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");

  const patch = (id: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  async function upload(files: File[]) {
    if (files.length === 0) return;
    setBusy(true);
    const added = files.map((f) => ({ id: next.current++, name: f.name, state: "uploading" as const }));
    setRows((rs) => [...added, ...rs]);
    for (const [i, file] of files.entries()) {
      const row = added[i]!;
      setAnnounce(`Uploading ${file.name}`);
      const body = new FormData();
      body.set("file", file);
      let message: string;
      try {
        const res = await uploadMediaAction(slug, body);
        if (res.ok && res.data.ok) {
          patch(row.id, { state: "accepted" });
          message = `${file.name} accepted`;
        } else {
          const reason = res.ok ? (res.data.ok ? "" : res.data.message) : res.message;
          patch(row.id, { state: "rejected", reason });
          message = `${file.name} rejected: ${reason}`;
        }
      } catch {
        patch(row.id, { state: "rejected", reason: "The upload failed. Try again." });
        message = `${file.name} rejected: the upload failed`;
      }
      setAnnounce(message);
    }
    setBusy(false);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void upload([...e.dataTransfer.files]);
      }}
      className={`flex flex-col gap-3 rounded-lg border border-dashed p-4 ${over ? "border-foreground bg-foreground/5" : "border-foreground/40"}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label="Image files"
          tabIndex={-1}
          onChange={(e) => {
            void upload([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <Button pending={busy} pendingLabel="Uploading…" onClick={() => input.current?.click()}>
          Choose files
        </Button>
        <p className="text-sm">Or drop images here. JPEG, PNG or WebP, up to {maxMegabytes} MB each.</p>
      </div>
      <LiveRegion message={announce} />
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="font-medium">{r.name}</span>:{" "}
              {r.state === "uploading" ? "uploading…" : r.state === "accepted" ? "accepted" : `rejected: ${r.reason}`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
