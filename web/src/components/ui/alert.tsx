import * as React from "react";
import { AlertTriangle, Info } from "lucide-react";

import { cn } from "@/lib/utils";

type AlertVariant = "destructive" | "warn" | "muted" | "success";

interface AlertProps extends Omit<React.ComponentProps<"div">, "title"> {
  variant?: AlertVariant;
  title?: React.ReactNode;
}

const cls: Record<AlertVariant, string> = {
  destructive: "ui-alert--bad",
  warn: "ui-alert--warn",
  muted: "",
  success: "",
};

/** Inline alert: an icon, an optional bold line and a detail line. */
function Alert({ className, variant = "destructive", title, children, ...props }: AlertProps) {
  const Icon = variant === "destructive" || variant === "warn" ? AlertTriangle : Info;
  return (
    <div role="alert" data-slot="alert" className={cn("ui-alert", cls[variant], className)} {...props}>
      <Icon
        className={cn("mt-px h-[17px] w-[17px] flex-none", variant === "muted" && "text-brand-text", variant === "success" && "text-good")}
        strokeWidth={2}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title ? <span className="ui-alert__title">{title}</span> : null}
        <span className={cn(variant === "destructive" && !title && "text-fg")}>{children}</span>
      </span>
    </div>
  );
}

export { Alert };
