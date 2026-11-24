"use client";

import { cn } from "@/lib/utils";
import { Tag } from "@/components/ui/badge";

interface ChoiceCardProps<T extends string> {
  value: T;
  current: T;
  onSelect: (v: T) => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  disabled?: boolean;
  /** Shown as a tag when the choice cannot be picked, e.g. "Not offered". */
  disabledTag?: string;
  className?: string;
}

/** Radio card for a small set of exclusive choices. */
export function ChoiceCard<T extends string>({
  value,
  current,
  onSelect,
  title,
  subtitle,
  disabled,
  disabledTag,
  className,
}: ChoiceCardProps<T>) {
  const active = value === current && !disabled;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => !disabled && onSelect(value)}
      disabled={disabled}
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-well border px-4 py-3.5 text-left transition-colors",
        active ? "border-brand-line bg-brand-soft" : "border-line bg-ground hover:border-line-strong",
        disabled && "cursor-not-allowed border-dashed border-line-strong bg-transparent text-fg-3 hover:border-line-strong",
        className,
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border-2",
          active ? "border-brand-text" : "border-line-control",
        )}
      >
        {active ? <span className="h-2 w-2 rounded-full bg-brand-text" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-bold">
          {title}
          {disabled && disabledTag ? <Tag>{disabledTag}</Tag> : null}
        </span>
        {subtitle ? <span className={cn("text-xs", disabled ? "text-fg-3" : "text-fg-2")}>{subtitle}</span> : null}
      </span>
    </button>
  );
}

interface CheckRowProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: React.ReactNode;
  note?: React.ReactNode;
  trailing?: React.ReactNode;
  disabled?: boolean;
}

/** Full-width checkbox row. */
export function CheckRow({ checked, onChange, title, note, trailing, disabled }: CheckRowProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-center gap-3 rounded-well border px-4 py-3 text-left transition-colors disabled:opacity-50",
        checked ? "border-brand-line bg-brand-soft" : "border-line bg-ground hover:border-line-strong",
      )}
    >
      <span
        className={cn(
          "flex h-5 w-5 flex-none items-center justify-center rounded-[6px] border-2 text-[12px] font-bold leading-none",
          checked ? "border-brand-text bg-brand-text text-ground" : "border-line-control",
        )}
        aria-hidden="true"
      >
        {checked ? "✓" : ""}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-bold">{title}</span>
        {note ? <span className="text-xs text-fg-2">{note}</span> : null}
      </span>
      {trailing}
    </button>
  );
}
