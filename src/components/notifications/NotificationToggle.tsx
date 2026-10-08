import { setNotifications } from "@/app/notifications/actions";
import { Button } from "@/components/ui/Button";

/** One project's on/off switch. A plain server form, so it works without JavaScript. */
export function NotificationToggle({ slug, name, on }: { slug: string; name: string; on: boolean }) {
  return (
    <form
      action={async (formData: FormData) => {
        "use server";
        await setNotifications(null, formData);
      }}
    >
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="on" value={on ? "false" : "true"} />
      <Button type="submit" variant="secondary" size="sm">
        {on ? "Turn off" : "Turn on"}
        <span className="sr-only"> notifications for {name}</span>
      </Button>
    </form>
  );
}
