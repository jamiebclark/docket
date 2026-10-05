"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { counterText, fetchCheck, groupIssues, isOverLimit, SEVERITY_LABEL, type CheckResult } from "../../../compose/composer-logic";
import { approveAction } from "../../../review/actions";
import { updatePostVariantsAction } from "../../actions";
import { CHECK_DEBOUNCE_MS, cardCheck, checkInputFor, createDebounce, editsFor, liveCards, type VariantCard } from "./variant-logic";

export interface VariantEditorProps {
  slug: string;
  postId: string;
  cards: VariantCard[];
  mediaIds: string[];
  canEdit: boolean;
  /** Review-only: offers **Save and approve**, which approves the post with these texts. */
  reviewing?: boolean;
  /** A check result to start from (server rendering and tests). */
  initialCheck?: CheckResult | null;
}

export function VariantEditor({ slug, postId, cards, mediaIds, canEdit, reviewing = false, initialCheck = null }: VariantEditorProps) {
  const router = useRouter();
  const uid = useId();
  const [texts, setTexts] = useState(() => Object.fromEntries(cards.map((c) => [c.key, c.text])));
  const [check, setCheck] = useState<CheckResult | null>(initialCheck);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const debounce = useRef(createDebounce(CHECK_DEBOUNCE_MS));
  const live = useMemo(() => liveCards(cards, texts), [cards, texts]);

  useEffect(() => {
    const d = debounce.current;
    return () => d.cancel();
  }, []);

  // Show `used / limit` and issues from the first render, not only after an edit (F2).
  useEffect(() => {
    if (initialCheck) return;
    let cancelled = false;
    void fetchCheck(slug, checkInputFor(postId, cards, mediaIds)).then((r) => {
      if (r && !cancelled) setCheck(r);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, postId, cards, mediaIds, initialCheck]);

  function edit(key: string, text: string) {
    const next = { ...texts, [key]: text };
    setTexts(next);
    debounce.current.schedule(() => {
      void fetchCheck(slug, checkInputFor(postId, liveCards(cards, next), mediaIds)).then(
        (r) => r && setCheck(r),
      );
    });
  }

  function save() {
    start(async () => {
      const r = await updatePostVariantsAction(slug, {
        postId,
        edits: editsFor(live),
      });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      setMessage(r.data.problems.length > 0 ? "Saved. Some versions still have problems." : "Saved.");
      router.refresh();
    });
  }

  function saveAndApprove() {
    start(async () => {
      const r = await approveAction(slug, {
        postId,
        edits: editsFor(live),
      });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      if (!r.data.ok) {
        setMessage(`Error: ${r.data.message}`);
        if (r.data.code === "already_reviewed") router.refresh();
        return;
      }
      const unscheduled = r.data.queued.filter((q) => !q.ok);
      setMessage(
        unscheduled.length > 0
          ? `Approved. Not scheduled: ${unscheduled.map((q) => (q.ok ? "" : q.message)).join(" ")}`
          : "Approved.",
      );
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {live.map((c) => {
        const t = cardCheck(check, c);
        const over = t ? isOverLimit(t) : false;
        const id = `${uid}-${c.key}`;
        return (
          <article key={c.key} aria-labelledby={`${id}-title`} className="flex flex-col gap-2 rounded-lg border border-foreground/20 p-4">
            <h3 id={`${id}-title`} className="text-base font-semibold">
              {c.providerName}: {c.accountNames.join(", ")}
            </h3>
            <label htmlFor={id} className="sr-only">
              {c.providerName}: {c.accountNames.join(", ")} text
            </label>
            <textarea
              id={id}
              rows={5}
              value={c.text}
              readOnly={!canEdit}
              aria-describedby={`${id}-count`}
              onChange={(e) => edit(c.key, e.target.value)}
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
        <div className="flex justify-end gap-2">
          <Button variant={reviewing ? "secondary" : "primary"} onClick={save} pending={pending} pendingLabel="Saving…">
            Save
          </Button>
          {reviewing ? (
            <Button onClick={saveAndApprove} pending={pending} pendingLabel="Approving…">
              Save and approve
            </Button>
          ) : null}
        </div>
      ) : null}
      <LiveRegion message={message} />
      {message ? <p className="text-sm">{message}</p> : null}
    </div>
  );
}
