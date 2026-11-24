"use client";

import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  title?: string;
  className?: string;
}

export function Switch({ checked, onCheckedChange, disabled, label, title, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn("ui-switch", className)}
    >
      <span />
    </button>
  );
}
