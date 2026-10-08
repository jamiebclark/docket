import { Skeleton } from "@/components/ui/Skeleton";

export default function AllActivityLoading() {
  return (
    <main id="main" aria-busy="true" aria-label="Loading activity" className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-8">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-5 w-72" />
      <Skeleton className="h-10 w-full max-w-xl" />
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </main>
  );
}
