import * as React from "react";
import { cn } from "@/lib/utils";

/** Grid of three or four headline numbers. */
export function StatTiles({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("ui-stats", className)} {...props} />;
}

interface StatTileProps {
  label: React.ReactNode;
  value: React.ReactNode;
  note?: React.ReactNode;
  /** The one most important tile gets the corner glow. */
  highlight?: boolean;
  /** Only when the value is itself a status. */
  tone?: "good" | "warn" | "bad";
  loading?: boolean;
  className?: string;
}

const toneClass = { good: "text-good", warn: "text-warn", bad: "text-bad" } as const;

export function StatTile({ label, value, note, highlight, tone, loading, className }: StatTileProps) {
  return (
    <div className={cn("ui-card ui-stat", highlight && "ui-card--corner", className)}>
      <span className="label">{label}</span>
      {loading ? (
        <span className="ui-skeleton my-1 h-[26px] w-20" />
      ) : (
        <span className={cn("t-stat truncate", tone && toneClass[tone])}>{value}</span>
      )}
      {note ? <span className="note">{note}</span> : null}
    </div>
  );
}
