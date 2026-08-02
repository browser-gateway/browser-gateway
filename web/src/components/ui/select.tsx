"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDismissible } from "@/lib/use-dismissible";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

interface Props<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
  align?: "left" | "right";
  width?: string;
}

/** Custom Select styled to match the SaaS dashboard picker — same
 *  trigger geometry (h-8 rounded-md border-border bg-background), same menu
 *  (bg-card border rounded-[10px] shadow-menu), same dismiss-on-outside-click.
 *  Replaces the native `<select>` (which renders using the OS's menu chrome). */
export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
  className,
  align = "left",
  width = "min-w-[14rem]",
}: Props<T>) {
  const [open, setOpen] = React.useState(false);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => setOpen(false), []);
  useDismissible(open, wrapperRef, close);
  const active = options.find((o) => o.value === value) ?? null;

  return (
    <div ref={wrapperRef} className={cn("relative", className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-2 h-8 px-3 rounded-md border border-border bg-background text-sm font-medium hover:bg-muted/40 disabled:opacity-60",
        )}
      >
        {label ? (
          <span className="text-muted-foreground text-xs">{label}</span>
        ) : null}
        <span>{active?.label ?? value}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" strokeWidth={1.75} />
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute top-9 bg-card border border-border rounded-[10px] p-1.5 shadow-md z-40",
            width,
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitem"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className="w-full flex items-start gap-2 px-2.5 py-1.5 rounded-md text-sm hover:bg-muted text-left"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{o.label}</span>
                  {o.value === value ? (
                    <Check className="h-3.5 w-3.5" strokeWidth={2} />
                  ) : null}
                </div>
                {o.hint ? (
                  <p className="text-xs text-muted-foreground mt-0.5">{o.hint}</p>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
