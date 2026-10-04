"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { listMediaAction, updateMediaAction, uploadMediaAction } from "@/app/p/[projectSlug]/media/actions";
import { POST_MEDIA_MAX } from "@/lib/validation/scheduling";
import type { MediaView } from "@/server/services/media";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { LiveRegion } from "../ui/LiveRegion";

/** Returns a copy with the item at `from` moved to `to`; out-of-range moves return the list unchanged. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return [...items];
  const out = [...items];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

type Library = Awaited<ReturnType<typeof listMediaAction>>;

function AltEditor({ slug, item, onSaved }: { slug: string; item: MediaView; onSaved: (v: MediaView) => void }) {
  const [alt, setAlt] = useState(item.altText);
  const [state, setState] = useState("");
  const [, start] = useTransition();
  const id = `picker-alt-${item.id}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        Alt text
      </label>
      <textarea
        id={id}
        value={alt}
        rows={2}
        maxLength={2000}
        onChange={(e) => setAlt(e.target.value)}
        onBlur={() => {
          if (alt === item.altText) return;
          start(async () => {
            const res = await updateMediaAction(slug, { id: item.id, altText: alt });
            if (res.ok) {
              onSaved(res.data);
              setState("Saved");
            } else setState(res.message);
          });
        }}
        className="rounded-md border border-foreground/40 bg-background px-2 py-1 text-sm"
      />
      <p aria-live="polite" className="min-h-4 text-xs">
        {state}
      </p>
    </div>
  );
}

/**
 * The composer's image control. The parent owns the ordered list; ids go to the server, views are for display.
 * Reordering uses buttons, not drag and drop, so it works from the keyboard.
 */
export function MediaPicker({
  slug,
  enabled,
  canEdit,
  value,
  onChange,
}: {
  slug: string;
  enabled: boolean;
  canEdit: boolean;
  value: MediaView[];
  onChange: (next: MediaView[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  if (!enabled) return <p className="text-sm">Media storage is not set up, so images can&apos;t be attached.</p>;

  const move = (i: number, to: number) => {
    onChange(moveItem(value, i, to));
    setAnnounce(`Moved ${value[i]?.originalFilename ?? "image"} to position ${to + 1} of ${value.length}`);
  };
  const full = value.length >= POST_MEDIA_MAX;
  return (
    <div className="flex flex-col gap-3">
      <LiveRegion message={announce} />
      {value.length === 0 ? <p className="text-sm">No images attached.</p> : null}
      <ol className="flex flex-col gap-3">
        {value.map((m, i) => (
          <li key={m.id} className="flex gap-3 rounded-lg border border-foreground/30 p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={m.thumbnailUrl} alt={m.altText || ""} className="size-20 shrink-0 rounded object-cover" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p className="truncate text-sm font-medium">
                {i + 1}. {m.originalFilename ?? "Image"}
              </p>
              {canEdit ? (
                <AltEditor slug={slug} item={m} onSaved={(v) => onChange(value.map((x) => (x.id === v.id ? v : x)))} />
              ) : null}
              {canEdit ? (
                <div className="flex gap-2">
                  <Button variant="secondary" disabled={i === 0} aria-label={`Move image ${i + 1} up`} onClick={() => move(i, i - 1)}>
                    Move up
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={i === value.length - 1}
                    aria-label={`Move image ${i + 1} down`}
                    onClick={() => move(i, i + 1)}
                  >
                    Move down
                  </Button>
                  <Button variant="danger" aria-label={`Remove image ${i + 1}`} onClick={() => onChange(value.filter((x) => x.id !== m.id))}>
                    Remove
                  </Button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {canEdit ? (
        <div>
          <Button variant="secondary" disabled={full} onClick={() => setOpen(true)}>
            Add images
          </Button>
          {full ? <p className="mt-1 text-xs">A post can have at most {POST_MEDIA_MAX} images.</p> : null}
        </div>
      ) : null}
      <PickerDialog
        slug={slug}
        open={open}
        onClose={() => setOpen(false)}
        chosen={value}
        onAdd={(items) => {
          onChange([...value, ...items.filter((m) => !value.some((x) => x.id === m.id))].slice(0, POST_MEDIA_MAX));
          setOpen(false);
        }}
      />
    </div>
  );
}

function PickerDialog({
  slug,
  open,
  onClose,
  chosen,
  onAdd,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  chosen: MediaView[];
  onAdd: (items: MediaView[]) => void;
}) {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [unused, setUnused] = useState(false);
  const [lib, setLib] = useState<Library | null>(null);
  const [picked, setPicked] = useState<MediaView[]>([]);
  const [uploadMsg, setUploadMsg] = useState("");
  const [reload, setReload] = useState(0);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      void listMediaAction(slug, { ...(q ? { q } : {}), ...(tag ? { tag } : {}), ...(unused ? { unused: true } : {}) }).then((r) => {
        if (live) setLib(r);
      });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, slug, q, tag, unused, reload]);

  const room = POST_MEDIA_MAX - chosen.length;
  const toggle = (m: MediaView) =>
    setPicked((p) => (p.some((x) => x.id === m.id) ? p.filter((x) => x.id !== m.id) : p.length < room ? [...p, m] : p));

  async function upload(files: File[]) {
    for (const f of files) {
      setUploadMsg(`Uploading ${f.name}…`);
      const body = new FormData();
      body.set("file", f);
      const res = await uploadMediaAction(slug, body);
      if (res.ok && res.data.ok) {
        const asset = res.data.asset;
        setPicked((p) => (p.length < room ? [...p, asset] : p));
        setUploadMsg(`${f.name} uploaded and selected`);
        setReload((n) => n + 1);
      } else setUploadMsg(`${f.name} rejected: ${res.ok ? (res.data.ok ? "" : res.data.message) : res.message}`);
    }
  }

  const items = (lib?.ok ? lib.data.items : []).filter((m) => !chosen.some((c) => c.id === m.id));
  return (
    <Dialog open={open} onClose={onClose} title="Add images">
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="picker-q">
            Search images
          </label>
          <input id="picker-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="rounded-md border border-foreground/40 bg-background px-2 py-1 text-sm" />
          <label className="sr-only" htmlFor="picker-tag">
            Filter by tag
          </label>
          <select id="picker-tag" value={tag} onChange={(e) => setTag(e.target.value)} className="rounded-md border border-foreground/40 bg-background px-2 py-1 text-sm">
            <option value="">All tags</option>
            {(lib?.ok ? lib.data.tags : []).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={unused} onChange={(e) => setUnused(e.target.checked)} /> Unused only
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input ref={file} type="file" multiple accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Image files" tabIndex={-1} onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
          <Button variant="secondary" onClick={() => file.current?.click()}>
            Upload new
          </Button>
          <span aria-live="polite" className="text-xs">
            {uploadMsg}
          </span>
        </div>
        {!lib ? <p className="text-sm">Loading…</p> : !lib.ok ? <p role="alert" className="text-sm">{lib.message}</p> : items.length === 0 ? <p className="text-sm">No images found.</p> : null}
        <ul className="grid grid-cols-3 gap-2">
          {items.map((m) => {
            const on = picked.some((x) => x.id === m.id);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(m)}
                  className={`w-full rounded border-2 p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground ${on ? "border-foreground" : "border-transparent"}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={m.thumbnailUrl} alt={m.altText || ""} className="aspect-square w-full rounded object-cover" />
                  <span className="block truncate text-xs">{m.originalFilename ?? "Image"}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={picked.length === 0} onClick={() => { onAdd(picked); setPicked([]); }}>
            Add {picked.length > 0 ? `${picked.length} ` : ""}selected
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
