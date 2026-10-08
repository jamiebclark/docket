import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import type { ProjectScope } from "@/server/dal";
import { projectUnread } from "@/server/services/notifications";

/** "Problems since you last looked" at the top of a project page. Hidden at zero and when muted; a failure just hides it. */
export async function ProblemsCallout({ scope }: { scope: ProjectScope }) {
  let unread = { count: 0, text: "" };
  try {
    unread = await projectUnread(scope);
  } catch (error) {
    console.error("notifications: could not count unread problems", error);
  }
  if (unread.count === 0) return null;
  return (
    <Alert tone="warning" role="status" className="mb-4">
      <p className="font-semibold">Problems since you last looked</p>
      <p>
        {unread.text} in {scope.project.name}.{" "}
        <Link href={`/p/${scope.project.slug}/activity?outcome=problems`} prefetch={false} className="underline">
          View problems
        </Link>
      </p>
    </Alert>
  );
}
