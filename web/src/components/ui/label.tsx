"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn("t-label mb-[7px] mt-4 block select-none first:mt-0", className)}
      {...props}
    />
  );
}

function FieldHint({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="field-hint" className={cn("t-small mt-[7px]", className)} {...props} />;
}

export { Label, FieldHint };
