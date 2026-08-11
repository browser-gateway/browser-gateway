"use client";

import * as React from "react";
import { createPortal } from "react-dom";
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
  fullWidth?: boolean;
}

/** Custom Select matching SaaS `WorkspacePicker` and `RouterPicker`. The menu
 *  renders via a portal to `document.body` so it's never clipped by an
 *  ancestor's `overflow: hidden` (e.g. a Card). Replaces the native `<select>`
 *  which renders using OS chrome. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
  className,
  align = "left",
  width = "min-w-[14rem]",
  fullWidth = false,
}: Props<T>) {
  const [open, setOpen] = React.useState(false);
  const [rect, setRect] = React.useState<DOMRect | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => {
    setOpen(false);
    setRect(null);
  }, []);
  const dismissRefs = React.useMemo(() => [wrapperRef, menuRef], []);
  useDismissible(open, dismissRefs, close);
  const active = options.find((o) => o.value === value) ?? null;

  function toggle() {
    if (open) {
      close();
      return;
    }
    if (triggerRef.current) {
      setRect(triggerRef.current.getBoundingClientRect());
    }
    setOpen(true);
  }

  React.useEffect(() => {
    if (!open) return;
    const onScroll = () => close();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  const menuStyle: React.CSSProperties | undefined = rect
    ? {
        position: "fixed",
        top: rect.bottom + 4,
        left: align === "right" ? undefined : rect.left,
        right: align === "right" ? window.innerWidth - rect.right : undefined,
        minWidth: fullWidth ? rect.width : undefined,
      }
    : undefined;

  return (
    <div ref={wrapperRef} className={cn("relative", fullWidth && "w-full", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background text-sm font-medium hover:bg-muted/40 disabled:opacity-60 focus:outline-none focus:ring-1 focus:ring-ring",
          fullWidth && "w-full justify-between",
        )}
      >
        <span className="inline-flex items-center gap-2 min-w-0">
          {label ? (
            <span className="text-muted-foreground text-xs shrink-0">{label}</span>
          ) : null}
          <span className="truncate">{active?.label ?? value}</span>
        </span>
        <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" strokeWidth={1.75} />
      </button>
      {open && rect && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={menuStyle}
              className={cn(
                "bg-card border border-border rounded-[10px] p-1.5 shadow-lg z-[100]",
                !fullWidth && width,
              )}
            >
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onChange(o.value);
                    close();
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
