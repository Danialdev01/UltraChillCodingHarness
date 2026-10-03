import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Skeleton className="size-5 rounded-md" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-56" />
        </div>
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className="h-3 w-24" />
      <div className="rounded-lg border">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-3 py-2.5 last:border-b-0">
            <Skeleton className="h-3" style={{ width: `${20 + ((i * 17) % 30)}%` }} />
            <Skeleton className="ml-auto h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
