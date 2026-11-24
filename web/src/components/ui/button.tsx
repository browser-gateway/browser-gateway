import * as React from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "ui-btn select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[15px]",
  {
    variants: {
      variant: {
        primary: "ui-btn--primary",
        accent: "ui-btn--accent",
        outline: "",
        destructive: "ui-btn--danger",
        "destructive-outline": "ui-btn--danger-outline",
        ghost: "ui-btn--ghost",
        link: "t-link h-auto border-0 p-0 hover:bg-transparent",
      },
      size: {
        default: "",
        sm: "ui-btn--sm",
        xs: "ui-btn--sm",
        lg: "ui-btn--lg",
        full: "w-full",
        icon: "ui-btn--icon",
        "icon-sm": "ui-btn--sm ui-btn--icon",
        "icon-xs": "ui-btn--sm ui-btn--icon",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

type ButtonBase = React.ComponentProps<typeof ButtonPrimitive>;

interface LoadingProps {
  /** Disables the button and swaps its icon for a spinner. */
  loading?: boolean;
  loadingLabel?: React.ReactNode;
}

/** Pill button. `accent` is the one page-level create action, `primary` the one main action in a dialog or hero card, `outline` everything else. */
function Button({
  className,
  variant,
  size,
  loading,
  loadingLabel,
  disabled,
  children,
  ...props
}: ButtonBase & VariantProps<typeof buttonVariants> & LoadingProps) {
  const isBusy = Boolean(loading);
  return (
    <ButtonPrimitive
      data-slot="button"
      data-loading={isBusy || undefined}
      disabled={disabled || isBusy}
      aria-busy={isBusy || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {isBusy ? <Loader2 className="size-3.5 animate-spin" strokeWidth={2.2} aria-hidden="true" /> : null}
      {isBusy && loadingLabel !== undefined ? loadingLabel : children}
    </ButtonPrimitive>
  );
}

export { Button, buttonVariants };
