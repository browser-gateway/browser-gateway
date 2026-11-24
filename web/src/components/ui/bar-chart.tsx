"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface Bar {
  key: string;
  value: number;
  /** Tooltip and screen-reader text for the bar. */
  label: string;
}

interface BarChartProps {
  bars: Bar[];
  max?: number;
  /** The readout for the hovered or selected bar. */
  format?: (bar: Bar) => { top: React.ReactNode; sub?: React.ReactNode };
  ariaLabel: string;
  height?: number;
  /** First, middle and last x labels. */
  axis?: [string, string, string];
  /** The value of the dashed guide line at the top. */
  guide?: string;
  /** Heading shown to the left of the readout. */
  header?: React.ReactNode;
  className?: string;
}

/** Single-series bars, one hue. The hovered or selected bar is full accent and feeds the readout, which defaults to the peak. */
export function BarChart({ bars, max, format, ariaLabel, height = 170, axis, guide, header, className }: BarChartProps) {
  const top = max ?? Math.max(...bars.map((b) => b.value), 0.000001);
  const peak = bars.reduce<Bar | undefined>((a, b) => (!a || b.value > a.value ? b : a), undefined);
  const [active, setActive] = React.useState<string | null>(null);
  const cur = bars.find((b) => b.key === active) ?? peak;
  const readout = cur && format ? format(cur) : null;
  return (
    <div className={cn("flex flex-col gap-3.5", className)}>
      {readout || header ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">{header}</div>
          {readout ? (
            <div className="ml-auto flex flex-col items-end gap-px">
              <span className="t-mono text-sm font-medium">{readout.top}</span>
              {readout.sub ? <span className="t-small">{readout.sub}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="relative">
        {guide ? (
          <span className="t-mono absolute right-0 top-[-10px] z-[1] text-[10px] text-fg-3">{guide}</span>
        ) : null}
        {guide ? <span aria-hidden="true" className="absolute inset-x-0 top-2 border-t border-dashed border-line" /> : null}
        <div role="img" aria-label={ariaLabel} className="ui-bars" style={{ height }}>
          {bars.map((b) => (
            <button
              key={b.key}
              type="button"
              title={b.label}
              aria-label={b.label}
              aria-current={cur?.key === b.key}
              onMouseEnter={() => setActive(b.key)}
              onFocus={() => setActive(b.key)}
              onClick={() => setActive(b.key)}
            >
              {b.value > 0 ? <i style={{ height: `${Math.max(2, (b.value / top) * 100)}%` }} /> : <i data-zero="" />}
            </button>
          ))}
        </div>
      </div>
      {axis ? (
        <div className="flex justify-between text-xs text-fg-3">
          <span>{axis[0]}</span>
          <span>{axis[1]}</span>
          <span>{axis[2]}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Small decorative bars for a summary card. */
export function SparkBars({ values, className }: { values: number[]; className?: string }) {
  const top = Math.max(...values, 0.000001);
  return (
    <div aria-hidden="true" className={cn("flex h-12 items-end gap-[3px]", className)}>
      {values.map((v, i) => (
        <i
          key={i}
          className={cn("block min-h-[2px] flex-1 rounded-t-[3px]", v > 0 ? "bg-brand-text" : "bg-line-strong")}
          style={{ height: `${v > 0 ? (v / top) * 100 : 0}%` }}
        />
      ))}
    </div>
  );
}
