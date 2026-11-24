import * as React from "react";
import { cn } from "@/lib/utils";

interface MeterProps {
  value: number;
  max?: number;
  tone?: "accent" | "good";
  height?: number;
  className?: string;
  label?: string;
}

/** Thin progress or share bar. */
export function Meter({ value, max = 1, tone = "accent", height = 8, className, label }: MeterProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn("ui-meter block", tone === "good" && "ui-meter--good", className)}
      style={{ height, borderRadius: height / 2 }}
    >
      <i style={{ width: `${pct}%`, minWidth: pct > 0 ? 3 : 0 }} />
    </span>
  );
}

interface MeterRowProps extends MeterProps {
  name: React.ReactNode;
  amount: React.ReactNode;
  dim?: boolean;
}

/** Share-of-total row: label left, mono value right, bar under. */
export function MeterRow({ name, amount, dim, ...meter }: MeterRowProps) {
  return (
    <div className={cn("flex flex-col gap-2", dim && "opacity-55")}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm font-semibold">{name}</span>
        <span className="t-mono flex-none text-xs text-fg-2">{amount}</span>
      </div>
      <Meter {...meter} />
    </div>
  );
}
