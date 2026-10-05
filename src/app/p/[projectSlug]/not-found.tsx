import Link from "next/link";
import { buttonStyles } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";

/** Renders inside the project shell's `<main>`, so it is a section, not another landmark. */
export default function ProjectNotFound() {
  return (
    <section className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-accent/60 text-accent-foreground">
        <Icon name="search" size={22} />
      </span>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">This page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      <Link href="/" className={buttonStyles({ variant: "primary" })}>
        Go to Docket
      </Link>
    </section>
  );
}
