"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

const COPIED_MS = 2000;

export function useCopy(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = React.useState(false);
  const copy = React.useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setCopied(false);
    }
  }, []);
  return [copied, copy];
}

interface CopyButtonProps {
  value: string;
  label?: string;
  variant?: "outline" | "primary";
  size?: "sm" | "md";
  iconOnly?: boolean;
  className?: string;
}

/** Reads "Copied" for two seconds after a copy. */
export function CopyButton({ value, label = "Copy", variant = "outline", size = "sm", iconOnly, className }: CopyButtonProps) {
  const [copied, copy] = useCopy();
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      aria-label={iconOnly ? (copied ? "Copied" : label) : undefined}
      className={cn(
        "ui-btn",
        size === "sm" && "ui-btn--sm",
        variant === "primary" && "ui-btn--primary",
        iconOnly && "ui-btn--icon",
        className,
      )}
    >
      <Icon className="size-[13px]" strokeWidth={2.2} />
      {iconOnly ? null : copied ? "Copied" : label}
    </button>
  );
}

interface CopyRowProps {
  value: string;
  /** What lands on the clipboard, when it differs from what is shown. */
  copyValue?: string;
  accent?: boolean;
  trailing?: React.ReactNode;
  className?: string;
}

/** A well holding a mono string that can wrap, with Copy at the right end. */
export function CopyRow({ value, copyValue, accent, trailing, className }: CopyRowProps) {
  return (
    <div
      className={cn(
        "ui-well flex flex-wrap items-center gap-2.5 py-2.5 pl-4 pr-2.5",
        accent && "border-brand-line",
        className,
      )}
    >
      <code className="t-mono min-w-0 flex-1 basis-[200px] text-[12.5px] leading-relaxed text-[var(--text-code)] [overflow-wrap:anywhere]">
        {value}
      </code>
      {trailing}
      <CopyButton value={copyValue ?? value} variant={accent ? "primary" : "outline"} />
    </div>
  );
}
