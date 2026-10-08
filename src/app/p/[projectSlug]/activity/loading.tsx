import { Skeleton } from "@/components/ui/Skeleton";

export default function ActivityLoading() {
  return (
    <div aria-busy="true" aria-label="Loading activity" className="flex flex-col gap-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-5 w-72" />
      <Skeleton className="h-10 w-full max-w-xl" />
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}
