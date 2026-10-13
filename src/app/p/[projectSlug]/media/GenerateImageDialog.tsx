"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ChoiceField } from "@/components/ui/ChoiceField";
import { Dialog } from "@/components/ui/Dialog";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { TextareaField } from "@/components/ui/TextareaField";
import { DEFAULT_IMAGE_ASPECT, IMAGE_PROMPT_MAX, type ImageAspect } from "@/server/llm/image-generation";
import { generateImageAction } from "./actions";

const ASPECT_OPTIONS: { value: ImageAspect; label: string }[] = [
  { value: "square", label: "Square" },
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
];

export function GenerateImageDialog({ slug }: { slug: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<ImageAspect>(DEFAULT_IMAGE_ASPECT);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [pending, start] = useTransition();

  const trimmed = prompt.trim();
  const canSubmit = !pending && trimmed.length > 0 && prompt.length <= IMAGE_PROMPT_MAX;

  function close() {
    setOpen(false);
    setError("");
  }

  function run() {
    setError("");
    setAnnouncement("Generating an image…");
    start(async () => {
      const result = await generateImageAction(slug, { prompt: trimmed, aspect });
      if (!result.ok) {
        setAnnouncement(result.message);
        setError(result.message);
        return;
      }
      if (!result.data.ok) {
        setAnnouncement(result.data.message);
        setError(result.data.message);
        return;
      }
      setAnnouncement("Image added to the library.");
      setPrompt("");
      setOpen(false);
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Generate an image
      </Button>
      <Dialog open={open} onClose={close} title="Generate an image" size="md" dismissOnBackdrop={false}>
        <LiveRegion message={announcement} />
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <TextareaField
            id={`${id}-prompt`}
            label="Describe the image"
            hint="Up to 1000 characters. Don't ask for a real, identifiable person — Docket tells the provider not to draw one."
            minRows={3}
            maxRows={10}
            maxLength={IMAGE_PROMPT_MAX}
            required
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <ChoiceField
            id={`${id}-aspect`}
            name="aspect"
            label="Shape"
            value={aspect}
            onChange={(v) => setAspect(v as ImageAspect)}
            options={ASPECT_OPTIONS}
          />
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="secondary" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" pending={pending} pendingLabel="Generating…" disabled={!canSubmit}>
              Generate
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
