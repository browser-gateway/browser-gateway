"use client";

import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDismissible } from "@/lib/use-dismissible";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

interface RowMenuProps {
  items: RowMenuItem[];
  align?: "left" | "right";
  className?: string;
}

/** The "more" button at the end of a row. */
export function RowMenu({ items, align = "right", className }: RowMenuProps) {
  const [open, setOpen] = React.useState(false);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => setOpen(false), []);
  useDismissible(open, wrapperRef, close);

  return (
    <div ref={wrapperRef} className={cn("ui-dd", className)} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="ui-btn ui-btn--sm ui-btn--icon"
      >
        <MoreHorizontal className="size-[15px]" strokeWidth={2} />
      </button>
      {open ? (
        <div role="menu" className={cn("ui-dd__menu min-w-[180px]", align === "right" && "ui-dd__menu--right")}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              data-tone={item.danger ? "danger" : undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className="ui-dd__opt"
            >
              <span className="name">{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
