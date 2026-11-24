"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  /** 560 for confirms and short forms, 600 to 640 for forms, 680 and 920 for the wide ones. */
  width?: number;
  label?: string;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

let openCount = 0;

/** Centred dialog on a blurred scrim. A bottom sheet at 860px and below. Traps focus, closes on Escape and scrim click, returns focus to the trigger. */
function Dialog({ open, onOpenChange, children, className, width = 560, label }: DialogProps) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    openCount += 1;
    document.body.style.overflow = "hidden";
    const box = boxRef.current;
    if (box && !box.contains(document.activeElement)) {
      const target = box.querySelector<HTMLElement>("[autofocus]") ?? box.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? box).focus({ preventScroll: true });
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (document.querySelector("[data-dd-open='true']")) return;
        e.stopPropagation();
        onOpenChange(false);
        return;
      }
      if (e.key !== "Tab" || !boxRef.current) return;
      const items = Array.from(boxRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openCount -= 1;
      if (openCount === 0) document.body.style.overflow = "";
      previous?.focus?.({ preventScroll: true });
    };
  }, [open, onOpenChange]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="ui-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn("ui-dialog outline-none", className)}
        style={{ width }}
      >
        <span aria-hidden="true" className="mx-auto -mb-2 -mt-1.5 hidden h-1 w-9 flex-none rounded-full bg-line-strong max-[860px]:block" />
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface DialogHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  leading?: React.ReactNode;
  onClose?: () => void;
}

/** Title, description and the round close button. */
function DialogHeader({ title, description, eyebrow, leading, onClose }: DialogHeaderProps) {
  return (
    <div className="ui-dialog__head">
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {eyebrow ? <span className="t-eyebrow">{eyebrow}</span> : null}
        <h2 className="t-dialog">{title}</h2>
        {description ? <p className="t-sub">{description}</p> : null}
      </div>
      {onClose ? (
        <button type="button" aria-label="Close" onClick={onClose} className="ui-dialog__close">
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 data-slot="dialog-title" className={cn("t-dialog", className)} {...props} />;
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-body" className={cn("t-sub flex flex-col", className)} {...props} />;
}

/** Footer: Cancel then the action, right aligned, above a rule. `note` sits at the left. */
function DialogActions({
  className,
  note,
  children,
  ...props
}: React.ComponentProps<"div"> & { note?: React.ReactNode }) {
  return (
    <div data-slot="dialog-actions" className={cn("ui-dialog__foot", className)} {...props}>
      {note ? <div className="mr-auto flex min-w-0 flex-wrap items-center gap-2 text-xs text-fg-3">{note}</div> : null}
      {children}
    </div>
  );
}

export { Dialog, DialogHeader, DialogTitle, DialogBody, DialogActions };
