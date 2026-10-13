import { Skeleton } from "@/components/ui/Skeleton";

export default function UsageLoading() {
  return (
    <div aria-busy="true" aria-label="Loading usage" className="flex flex-col gap-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
