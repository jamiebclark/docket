import type { ReactNode } from "react";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const tones: Record<Tone, string> = {
  neutral: "border-foreground/40",
  info: "border-blue-700 text-blue-800 dark:border-blue-400 dark:text-blue-300",
  success: "border-green-700 text-green-800 dark:border-green-400 dark:text-green-300",
  warning: "border-amber-700 text-amber-800 dark:border-amber-400 dark:text-amber-300",
  danger: "border-red-700 text-red-800 dark:border-red-400 dark:text-red-300",
};

/** Status badge. Always carries text; colour only reinforces it. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
