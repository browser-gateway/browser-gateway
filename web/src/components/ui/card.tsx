import * as React from "react";

import { cn } from "@/lib/utils";

export type CardVariant = "default" | "hero" | "corner" | "plain" | "selected" | "dashed" | "danger";

const variantClass: Record<CardVariant, string> = {
  default: "",
  hero: "ui-card--hero",
  corner: "ui-card--corner",
  plain: "ui-card--plain",
  selected: "ui-card--selected",
  dashed: "ui-card--dashed",
  danger: "ui-card--danger",
};

/** Dotted near-black card. One `hero` per page; `plain` behind dense rows of text. */
function Card({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & { variant?: CardVariant }) {
  return (
    <div
      data-slot="card"
      className={cn("ui-card min-w-0 p-[22px]", variantClass[variant], className)}
      {...props}
    />
  );
}

/** Sunken box inside a card: fact cells, option rows, inline notes. */
function Well({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="well" className={cn("ui-well min-w-0 px-4 py-3.5", className)} {...props} />;
}

/** Label over value, in a well. */
function Fact({
  label,
  value,
  mono,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("ui-well flex min-w-0 flex-col gap-0.5 px-[13px] py-[11px]", className)}>
      <span className="text-[11px] text-fg-3">{label}</span>
      <span className={cn("truncate text-sm font-semibold", mono && "t-mono font-medium")}>{value}</span>
    </div>
  );
}

function DangerCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="danger-card" className={cn("ui-card ui-card--danger min-w-0 p-[22px]", className)} {...props} />
  );
}

/** Heading row inside a card: title left, a link, tag or control right. */
function CardSectionHeader({
  className,
  children,
  action,
  size = "h3",
}: {
  className?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  size?: "h2" | "h3";
}) {
  return (
    <div className={cn("mb-3.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2", className)}>
      {size === "h2" ? <h2 className="t-h2">{children}</h2> : <h3 className="t-h3">{children}</h3>}
      {action}
    </div>
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-footer" className={cn("mt-4 border-t border-line-divider pt-4", className)} {...props} />
  );
}

export { Card, Well, Fact, DangerCard, CardSectionHeader, CardFooter };
