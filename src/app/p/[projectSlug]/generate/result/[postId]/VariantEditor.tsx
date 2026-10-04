"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { counterText, fetchCheck, groupIssues, isOverLimit, SEVERITY_LABEL, type CheckResult } from "../../../compose/composer-logic";
import { updatePostVariantsAction } from "../../actions";
import { CHECK_DEBOUNCE_MS, cardCheck, checkInputFor, createDebounce, type VariantCard } from "./variant-logic";

export interface VariantEditorProps {
  slug: string;
  postId: string;
  cards: VariantCard[];
  mediaIds: string[];
  canEdit: boolean;
  /** A check result to start from (server rendering and tests). */
  initialCheck?: CheckResult | null;
}

export function VariantEditor({ slug, postId, cards, mediaIds, canEdit, initialCheck = null }: VariantEditorProps) {
  const router = useRouter();
  const uid = useId();
  const [texts, setTexts] = useState(() => Object.fromEntries(cards.map((c) => [c.providerKey, c.text])));
  const [check, setCheck] = useState<CheckResult | null>(initialCheck);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const debounce = useRef(createDebounce(CHECK_DEBOUNCE_MS));
  const live = useMemo(() => cards.map((c) => ({ ...c, text: texts[c.providerKey] ?? c.text })), [cards, texts]);

  useEffect(() => {
    const d = debounce.current;
    return () => d.cancel();
  }, []);

  function edit(providerKey: string, text: string) {
    const next = { ...texts, [providerKey]: text };
    setTexts(next);
    debounce.current.schedule(() => {
      void fetchCheck(slug, checkInputFor(postId, cards.map((c) => ({ ...c, text: next[c.providerKey] ?? c.text })), mediaIds)).then(
        (r) => r && setCheck(r),
      );
    });
  }

  function save() {
    start(async () => {
      const r = await updatePostVariantsAction(slug, {
        postId,
        edits: live.map((c) => ({ providerKey: c.providerKey, text: c.text })),
      });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      setMessage(r.data.problems.length > 0 ? "Saved. Some versions still have problems." : "Saved.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {live.map((c) => {
        const t = cardCheck(check, c);
        const over = t ? isOverLimit(t) : false;
        const id = `${uid}-${c.providerKey}`;
        return (
          <article key={c.providerKey} aria-labelledby={`${id}-title`} className="flex flex-col gap-2 rounded-lg border border-foreground/20 p-4">
            <h3 id={`${id}-title`} className="text-base font-semibold">
              {c.providerName}
            </h3>
            <p className="text-xs text-foreground/70">For {c.accountNames.join(", ")}</p>
            <label htmlFor={id} className="sr-only">
              {c.providerName} text
            </label>
            <textarea
              id={id}
              rows={5}
              value={c.text}
              readOnly={!canEdit}
              aria-describedby={`${id}-count`}
              onChange={(e) => edit(c.providerKey, e.target.value)}
              className="rounded-md border border-foreground/40 bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
            />
            <p id={`${id}-count`} className={`text-right text-xs ${over ? "font-semibold text-red-700 dark:text-red-400" : "text-foreground/70"}`}>
              {t ? counterText(t) : ""}
              {over ? " (too long)" : ""}
            </p>
            {t
              ? groupIssues(t.issues).map((g) => (
                  <div key={g.severity}>
                    <p className="text-xs font-medium">{SEVERITY_LABEL[g.severity]}</p>
                    <ul className="list-disc pl-5 text-sm">
                      {g.items.map((i, n) => (
                        <li key={n} className={g.severity === "error" ? "text-red-700 dark:text-red-400" : g.severity === "warning" ? "text-amber-800 dark:text-amber-300" : ""}>
                          {g.severity === "error" ? "Error: " : g.severity === "warning" ? "Warning: " : ""}
                          {i.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              : null}
          </article>
        );
      })}
      {canEdit ? (
        <div className="flex justify-end">
          <Button onClick={save} pending={pending} pendingLabel="Saving…">
            Save
          </Button>
        </div>
      ) : null}
      <LiveRegion message={message} />
      {message ? <p className="text-sm">{message}</p> : null}
    </div>
  );
}
