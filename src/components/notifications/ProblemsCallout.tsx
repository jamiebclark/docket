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
      <p>
        {unread.text} since you last looked.{" "}
        <Link href={`/p/${scope.project.slug}/activity?outcome=problems`} prefetch={false} className="font-medium underline">
          See the problems
        </Link>
      </p>
    </Alert>
  );
}
