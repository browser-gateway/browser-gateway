import * as React from "react";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

interface BadgeProps extends React.ComponentProps<"span"> {
  variant?: "kind" | "revoked";
}

/** Tiny uppercase marker beside a name: DEFAULT, PREVIEW, SOON. */
function Badge({ className, variant = "kind", ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn("ui-tag ml-1.5 align-middle", variant === "revoked" && "border-bad-line text-bad", className)}
      {...props}
    />
  );
}

function Tag({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="tag" className={cn("ui-tag", className)} {...props} />;
}

/** Small neutral label: provider names, parameters, counts. `mono` for IDs and code. */
function DataChip({ className, mono, ...props }: React.ComponentProps<"span"> & { mono?: boolean }) {
  return <span data-slot="data-chip" className={cn("ui-chip", mono && "t-mono font-medium", className)} {...props} />;
}

/** A dot and a word. Colour never carries the meaning alone. */
function StatusBadge({
  tone = "neutral",
  className,
  ...props
}: React.ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      data-slot="status-badge"
      className={cn("ui-status", tone !== "neutral" && `ui-status--${tone}`, className)}
      {...props}
    />
  );
}

export { Badge, Tag, DataChip, StatusBadge };
