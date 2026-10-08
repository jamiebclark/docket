"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { checkStyles, controlStyles, hintStyles, labelStyles } from "@/components/ui/controls";
import type { VideoEdit, VideoFit } from "@/lib/video/edit";
import type { MediaView } from "@/server/services/media";
import { FocalPointPicker } from "./FocalPointPicker";
import { checkTrim, formatTrim, lengthText } from "./video-edit-ui";

const FIT_OPTIONS = [
  { value: "pad_blur", label: "Pad with a blurred copy" },
  { value: "pad_color", label: "Pad with a colour" },
  { value: "crop", label: "Crop" },
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Trim, fit, colour, focal point and recommended shape for one attached video. Save applies the edit to the composer (it is
 * saved with the draft); Cancel discards. An invalid entry keeps the previous edit and says why.
 */
export function VideoEditDialog({
  open,
  onClose,
  media,
  label,
  edit,
  cutNotes,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  media: MediaView;
  /** "Video 2" or the filename. */
  label: string;
  edit: VideoEdit;
  /** Per-target cut notes from the last check; shown under the trim fields. */
  cutNotes: string[];
  onSave: (edit: VideoEdit) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`Edit ${label}`}>
      {/* Mounted only while open, so each opening starts from the saved edit. */}
      {open ? <EditForm media={media} label={label} edit={edit} cutNotes={cutNotes} onSave={onSave} onClose={onClose} /> : null}
    </Dialog>
  );
}

function EditForm({
  media,
  label,
  edit,
  cutNotes,
  onSave,
  onClose,
}: {
  media: MediaView;
  label: string;
  edit: VideoEdit;
  cutNotes: string[];
  onSave: (edit: VideoEdit) => void;
  onClose: () => void;
}) {
  const id = useId();
  const durationMs = Math.round((media.video?.durationSeconds ?? 0) * 1000);
  const [start, setStart] = useState(formatTrim(edit.trimStartMs));
  const [end, setEnd] = useState(edit.trimEndMs === null ? "" : formatTrim(edit.trimEndMs));
  const [fit, setFit] = useState<VideoFit>(edit.fit);
  const [color, setColor] = useState(edit.padColor);
  const [focal, setFocal] = useState({ x: edit.focalX, y: edit.focalY });
  const [recommended, setRecommended] = useState(edit.recommendedShape);
  const [error, setError] = useState<{ field: "start" | "end" | "color"; message: string } | null>(null);

  const save = () => {
    const trim = checkTrim(start, end, durationMs);
    if (!trim.ok) {
      setError({ field: trim.field, message: trim.message });
      return;
    }
    if (fit === "pad_color" && !HEX.test(color)) {
      setError({ field: "color", message: "Use a colour like #1a2b3c." });
      return;
    }
    onSave({
      trimStartMs: trim.startMs,
      trimEndMs: trim.endMs,
      fit,
      padColor: HEX.test(color) ? color.toLowerCase() : edit.padColor,
      focalX: focal.x,
      focalY: focal.y,
      recommendedShape: recommended,
    });
    onClose();
  };

  const whole = () => {
    setStart(formatTrim(0));
    setEnd("");
    setError(null);
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-3">
          <Field
            id={`${id}-start`}
            label="Start"
            hint="m:ss.s"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            {...(error?.field === "start" ? { error: error.message } : {})}
          />
          <Field
            id={`${id}-end`}
            label="End"
            hint="m:ss.s, empty for the end"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            {...(error?.field === "end" ? { error: error.message } : {})}
          />
        </div>
        <div className="flex items-center justify-between">
          <p className={hintStyles}>Length {lengthText(durationMs)}</p>
          <Button type="button" variant="ghost" size="sm" onClick={whole}>
            Whole video
          </Button>
        </div>
        {cutNotes.length > 0 ? (
          <ul className={`${hintStyles} flex list-disc flex-col gap-0.5 pl-4`} aria-label="Cuts by platform">
            {cutNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <SegmentedControl
        name={`${id}-fit`}
        label="Fit when the shape must change"
        options={FIT_OPTIONS}
        value={fit}
        onChange={(v) => setFit(v as VideoFit)}
      />

      {fit === "pad_color" ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-color`} className={labelStyles}>
            Pad colour
          </label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Pad colour picker"
              value={HEX.test(color) ? color.toLowerCase() : "#000000"}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-12 rounded border border-input"
            />
            <input
              id={`${id}-color`}
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-invalid={error?.field === "color" ? true : undefined}
              aria-describedby={`${id}-color-error`}
              className={`${controlStyles} max-w-32`}
            />
          </div>
          <p id={`${id}-color-error`} aria-live="polite" className="min-h-4 text-xs font-medium text-danger">
            {error?.field === "color" ? error.message : ""}
          </p>
        </div>
      ) : null}

      {fit === "crop" ? (
        <div className="flex flex-col gap-1.5">
          <p className={labelStyles}>Focal point</p>
          <p className={hintStyles}>Used when Docket crops this video. Click or use the arrow keys.</p>
          <FocalPointPicker src={media.thumbnailUrl} alt={`Poster frame of ${label}`} value={focal} onChange={setFocal} />
        </div>
      ) : null}

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={recommended} onChange={(e) => setRecommended(e.target.checked)} className={`${checkStyles} mt-0.5`} />
        <span>
          <span className={labelStyles}>Use each platform&apos;s recommended shape</span>
          <span className={`${hintStyles} block`}>Reframes to 9:16 for platforms that recommend it.</span>
        </span>
      </label>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}
