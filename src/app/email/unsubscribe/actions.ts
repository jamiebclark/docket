"use server";

// The four plain-POST submits on the unsubscribe page (contracts/http.md §1). Each resolves the token
// itself — no session, no user id from input (FR-029, FR-044) — then redirects back to the same page so
// it re-renders from the post-write state (idempotent either way).
import { redirect } from "next/navigation";
import { applyUnsubscribe } from "@/server/services/email";

function redirectTo(token: FormDataEntryValue | null, done: string, extra?: Record<string, string>): never {
  const params = new URLSearchParams({ t: typeof token === "string" ? token : "", done, ...extra });
  redirect(`/email/unsubscribe?${params.toString()}`);
}

export async function allOff(formData: FormData): Promise<void> {
  const token = formData.get("t");
  await applyUnsubscribe(token, { kind: "all_off" }, new Date());
  redirectTo(token, "all_off");
}

export async function projectOff(formData: FormData): Promise<void> {
  const token = formData.get("t");
  const projectSlug = formData.get("projectSlug");
  if (typeof projectSlug !== "string") redirectTo(token, "project_off");
  await applyUnsubscribe(token, { kind: "project_off", projectSlug }, new Date());
  redirectTo(token, "project_off", { project: projectSlug });
}

export async function digestInstead(formData: FormData): Promise<void> {
  const token = formData.get("t");
  await applyUnsubscribe(token, { kind: "digest" }, new Date());
  redirectTo(token, "digest");
}

export async function backOn(formData: FormData): Promise<void> {
  const token = formData.get("t");
  await applyUnsubscribe(token, { kind: "back_on" }, new Date());
  redirectTo(token, "back_on");
}
