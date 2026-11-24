"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  /** Grey prefix inside an inline trigger ("Provider"), and the accessible name. */
  label?: string;
  className?: string;
  align?: "left" | "right";
  width?: string;
  /** Block variant for forms and dialogs: full width, the menu opens in the flow. */
  fullWidth?: boolean;
  /** A link at the bottom of the menu to the page that creates one of these. */
  footer?: { label: string; href: string };
  placeholder?: string;
  mono?: boolean;
  id?: string;
  /** Keep `label` as the accessible name only, when the value already says what it is ("Any provider"). */
  hideLabel?: boolean;
  /** Extra classes for the trigger, for the few places it is drawn larger. */
  triggerClassName?: string;
  /** Replaces the plain chevron. */
  chevron?: React.ReactNode;
}

const SEARCH_ABOVE = 6;

/** The dropdown for any list that can grow. Never a native select. A pill in toolbars, a full-width field in forms, a bottom sheet on phones. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
  className,
  align = "left",
  fullWidth = false,
  footer,
  placeholder,
  mono,
  id,
  hideLabel,
  triggerClassName,
  chevron,
}: Props<T>) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [rect, setRect] = React.useState<DOMRect | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const active = options.find((o) => o.value === value) ?? null;
  const shown = query
    ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(query.toLowerCase()))
    : options;

  const close = React.useCallback((refocus = false) => {
    setOpen(false);
    setQuery("");
    setRect(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  function toggle() {
    if (open) {
      close();
      return;
    }
    if (!fullWidth && triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
    setCursor(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    }
    function onMove(e: Event) {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (!fullWidth) close();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, close, fullWidth]);

  function pick(o: SelectOption<T>) {
    if (o.disabled) return;
    onChange(o.value);
    close(true);
  }

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(shown.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = shown[cursor];
      if (o) pick(o);
    }
  }

  const menu = open ? (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onMenuKey}
      className={cn("ui-dd__menu", mono && "t-mono")}
      style={
        !fullWidth && rect
          ? {
              position: "fixed",
              top: rect.bottom + 6,
              left: align === "right" ? undefined : rect.left,
              right: align === "right" ? window.innerWidth - rect.right : undefined,
              minWidth: Math.max(230, rect.width),
              zIndex: 130,
            }
          : undefined
      }
    >
      {options.length > SEARCH_ABOVE ? (
        <input
          className="ui-dd__search"
          type="search"
          placeholder="Search"
          aria-label={label ? `Search ${label}` : "Search"}
          value={query}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
        />
      ) : null}
      {shown.length === 0 ? <span className="px-3 py-2 text-xs text-fg-3">Nothing matches.</span> : null}
      {shown.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="option"
          aria-selected={o.value === value}
          data-active={i === cursor}
          disabled={o.disabled}
          autoFocus={options.length <= SEARCH_ABOVE && i === cursor}
          onMouseEnter={() => setCursor(i)}
          onClick={() => pick(o)}
          className="ui-dd__opt"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="name">{o.label}</span>
            {o.hint ? <span className="note">{o.hint}</span> : null}
          </span>
          {o.value === value ? <span className="check">✓</span> : null}
        </button>
      ))}
      {footer ? (
        <Link className="ui-dd__footer" href={footer.href} onClick={() => close()}>
          {footer.label} →
        </Link>
      ) : null}
    </div>
  ) : null;

  return (
    <div
      ref={wrapperRef}
      data-dd-open={open || undefined}
      className={cn("ui-dd", fullWidth && "ui-dd--block", className)}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={fullWidth || hideLabel ? label : undefined}
        onClick={toggle}
        disabled={disabled}
        className={cn("ui-dd__btn", mono && fullWidth && "t-mono", triggerClassName)}
      >
        {!fullWidth && label && !hideLabel ? <span className="label">{label}</span> : null}
        <span className={cn("value", !active && "font-normal text-fg-3")}>
          {active?.label ?? placeholder ?? value}
        </span>
        {chevron ?? <ChevronDown className="h-3.5 w-3.5 flex-none text-fg-3" strokeWidth={2} />}
      </button>
      {fullWidth ? menu : menu && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
    </div>
  );
}

export { Select as Dropdown };
export type { SelectOption as DropdownOption };
