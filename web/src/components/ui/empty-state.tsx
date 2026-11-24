import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps extends Omit<React.ComponentProps<"div">, "title"> {
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  icon?: LucideIcon;
  /** `inline` is the one-line dashed box for "no results for these filters". */
  variant?: "card" | "bare" | "inline";
}

/** "None yet": a tinted icon circle, a heading, one sentence, one action. */
function EmptyState({ className, title, hint, action, icon: Icon, variant = "card", ...props }: EmptyStateProps) {
  if (variant === "inline") {
    return (
      <div
        data-slot="empty-state"
        className={cn("ui-card ui-card--dashed flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-5 py-6 text-center text-sm text-fg-2", className)}
        {...props}
      >
        <span>{title}</span>
        {hint ? <span className="text-fg-3">{hint}</span> : null}
        {action}
      </div>
    );
  }
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex w-full flex-col items-center gap-2.5 px-6 py-10 text-center",
        variant === "card" && "ui-card",
        className,
      )}
      {...props}
    >
      {Icon ? (
        <span className="ui-iconcircle h-[52px] w-[52px]">
          <Icon className="h-[22px] w-[22px]" strokeWidth={2} />
        </span>
      ) : null}
      <h2 className="t-h2">{title}</h2>
      {hint ? <span className="t-sub max-w-[460px]">{hint}</span> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
