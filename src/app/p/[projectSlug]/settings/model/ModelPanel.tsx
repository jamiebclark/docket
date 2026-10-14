"use client";

import { useActionState, useState } from "react";
import { alertStyles } from "@/components/ui/Alert";
import { Button, buttonStyles } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { LocalTime } from "@/components/ui/LocalTime";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { ActionResult } from "@/lib/action-result";
import { LLM_KEY_UNREADABLE, LLM_SOURCE_INSTALL, LLM_SOURCE_PROJECT } from "@/lib/generation/llm-source";
import type { LlmCheckResult } from "@/server/services/generation/check";
import { checkProjectModel, removeProjectModel, saveProjectModel } from "./actions";
import type { ProjectLlmDto } from "./dto";

/** `lastChange.at` arrives as a `Date` from a server action and as an ISO string from the initial server-rendered prop; `LocalTime` accepts either. */
type ModelView = Omit<ProjectLlmDto, "lastChange"> & {
  lastChange: { by: { id: string; name: string } | null; at: Date | string } | null;
};

function InUseLine({ inUse }: { inUse: ModelView["inUse"] }) {
  if ("missingSettings" in inUse) {
    return <p className="text-sm">Generation is not configured for this project. Set: {inUse.missingSettings.join(", ")}.</p>;
  }
  if ("unreadable" in inUse) {
    return (
      <div role="alert" className={alertStyles("danger")}>
        {LLM_KEY_UNREADABLE}
      </div>
    );
  }
  return (
    <>
      <p className="text-sm">
        {inUse.provider === "openai" ? "OpenAI" : "Anthropic"} · {inUse.model}
      </p>
      <p className="text-sm text-muted-foreground">
        {inUse.source === "project" ? LLM_SOURCE_PROJECT : LLM_SOURCE_INSTALL}
      </p>
    </>
  );
}

function checkOutcomeText(result: LlmCheckResult): string {
  if (result.ok) {
    const provider = result.provider === "openai" ? "OpenAI" : "Anthropic";
    const source = result.source === "project" ? "this project's own key" : "this Docket's key";
    return `Worked. ${provider} · ${result.model} · ${source} · answered in ${(result.latencyMs / 1000).toFixed(1)} s.`;
  }
  if (result.reason === "not_configured") return `Generation is not configured. Set: ${result.missingSettings.join(", ")}.`;
  return result.message;
}

export function ModelPanel({ slug, timeZone, view }: { slug: string; timeZone: string; view: ProjectLlmDto }) {
  const [saveState, saveAction, saving] = useActionState<Awaited<ReturnType<typeof saveProjectModel>> | null, FormData>(
    saveProjectModel,
    null,
  );
  const [checkState, checkAction, checking] = useActionState<ActionResult<LlmCheckResult> | null, FormData>(
    checkProjectModel,
    null,
  );
  const [removeState, removeAction, removing] = useActionState<Awaited<ReturnType<typeof removeProjectModel>> | null, FormData>(
    removeProjectModel,
    null,
  );

  const current: ModelView = saveState?.ok ? saveState.data : removeState?.ok ? removeState.data : view;
  const errors = saveState && !saveState.ok ? (saveState.fieldErrors ?? {}) : {};
  const formError = saveState && !saveState.ok && Object.keys(errors).length === 0 ? saveState.message : null;
  const [provider, setProvider] = useState(
    current.inUse.source === "project" && "provider" in current.inUse ? current.inUse.provider : "openai",
  );

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">In use now</h2>
        <InUseLine inUse={current.inUse} />
        {current.lastChange ? (
          <p className="text-sm text-muted-foreground">
            Last changed by {current.lastChange.by?.name ?? "a former member"} on{" "}
            <LocalTime value={current.lastChange.at} timeZone={timeZone} />
          </p>
        ) : null}
        <form action={checkAction}>
          <input type="hidden" name="slug" value={slug} />
          <Button type="submit" variant="secondary" pending={checking} pendingLabel="Checking…">
            Check this credential
          </Button>
        </form>
        {checkState ? (
          <p role="status" className="text-sm">
            {checkState.ok ? checkOutcomeText(checkState.data) : checkState.message}
          </p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">This project&apos;s own credential</h2>
        {formError ? (
          <p role="alert" className={alertStyles("danger")}>
            {formError}
          </p>
        ) : null}
        <form action={saveAction} className="flex flex-col gap-3">
          <input type="hidden" name="slug" value={slug} />
          <SegmentedControl
            name="provider"
            label="Provider"
            value={provider}
            onChange={(v) => setProvider(v as typeof provider)}
            error={errors.provider}
            options={[
              { value: "openai", label: "OpenAI" },
              { value: "anthropic", label: "Anthropic" },
            ]}
          />
          <Field
            id="model"
            name="model"
            label="Model id"
            hint="No spaces, at most 200 characters."
            required
            defaultValue={current.inUse.source === "project" && "model" in current.inUse ? current.inUse.model : ""}
            error={errors.model}
          />
          <Field
            id="apiKey"
            name="apiKey"
            type="password"
            autoComplete="off"
            label="API key"
            hint="Leave blank to keep the key already stored."
            maxLength={current.keyMaxLength}
            error={errors.apiKey}
          />
          <Button type="submit" variant="primary" pending={saving} pendingLabel="Saving…" className="self-start">
            Save
          </Button>
        </form>
      </Card>

      {/*
       * A disclosure rather than a modal: the confirmation has to work with client JavaScript off
       * (quickstart.md §4 part 4). A `<dialog>` is `display: none` until `showModal()` runs, so a remove
       * form inside one sits in the markup unreachable — which made remove the one action of the three a
       * no-JavaScript visitor could not perform. `<details>` opens natively, with or without JavaScript.
       * Same pattern as NotificationRowActions' snooze disclosure.
       */}
      {current.hasKey ? (
        <details className="self-start">
          <summary className={buttonStyles({ variant: "danger" }) + " cursor-pointer list-none"}>
            Remove this project&apos;s credential
          </summary>
          <div className="mt-2 max-w-md rounded-2xl border border-border bg-surface p-4 shadow-overlay">
            <p className="mb-4 text-sm">
              Generation in this project will go back to the model and API key configured for this Docket, and this
              project&apos;s stored key will be deleted. This cannot be undone.
            </p>
            {removeState && !removeState.ok ? (
              <p role="alert" className="mb-2 text-sm text-danger">
                {removeState.message}
              </p>
            ) : null}
            <form action={removeAction} className="flex gap-2">
              <input type="hidden" name="slug" value={slug} />
              <button type="submit" disabled={removing} className={buttonStyles({ variant: "danger" })}>
                {removing ? "Removing…" : "Remove credential"}
              </button>
            </form>
          </div>
        </details>
      ) : null}
    </div>
  );
}
