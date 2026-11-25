import * as React from "react";
import { cn } from "@/lib/utils";

/** Loading block at the final layout's size and radius. */
export function Skeleton({ className, ...props }: React.ComponentProps<"span">) {
  return <span aria-hidden="true" className={cn("ui-skeleton block", className)} {...props} />;
}

/** Stand-in rows for a list that is loading. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cn("flex flex-col gap-2 p-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-11 rounded-[14px]" />
      ))}
    </div>
  );
}
