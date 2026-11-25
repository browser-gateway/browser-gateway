import * as React from "react";
import { cn } from "@/lib/utils";

interface SpinnerProps {
  size?: "sm" | "lg";
  className?: string;
}

/** For a button or a running item. Page content loads with skeletons. */
function Spinner({ size = "sm", className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "animate-spin-slow inline-block flex-none rounded-full border-2 border-line-strong",
        size === "sm" ? "h-3.5 w-3.5" : "h-6 w-6",
        className,
      )}
      style={{ borderTopColor: "var(--brand-text)" }}
    />
  );
}

export { Spinner };
