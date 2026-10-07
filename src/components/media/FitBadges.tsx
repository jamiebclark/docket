import { Badge } from "../ui/Badge";
import type { PlatformFit } from "@/server/services/media-fit";
import { fitNote, fitText, fitTone } from "./fit-ui";

/**
 * One badge per platform plus a plain-text list of what will change or why an image is refused. Text, not colour
 * alone, and no tooltip, so it reads the same by keyboard and screen reader. `id` lets a parent link to the notes.
 */
export function FitBadges({ fit, id }: { fit: readonly PlatformFit[]; id?: string }) {
  if (fit.length === 0) return null;
  const notes = fit.map((f) => fitNote(f)).filter((n): n is string => n !== null);
  return (
    <div id={id} className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {fit.map((f) => (
          <Badge key={f.providerKey} tone={fitTone(f.state)}>
            {fitText(f)}
          </Badge>
        ))}
      </div>
      {notes.length > 0 ? (
        <ul aria-label="Platform notes" className="list-disc pl-4 text-xs text-muted-foreground">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
