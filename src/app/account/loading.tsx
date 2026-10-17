import { Skeleton } from "@/components/ui/Skeleton";

export default function AccountLoading() {
  return (
    <main id="main" aria-busy="true" aria-label="Loading your account" className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-8">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-5 w-80 max-w-full" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-72 w-full" />
    </main>
  );
}
