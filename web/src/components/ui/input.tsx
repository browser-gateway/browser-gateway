import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

/** Text input. Pass `font-mono` for technical values. */
function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <InputPrimitive data-slot="input" className={cn("ui-input", className)} {...props} />;
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn("ui-input", className)} {...props} />;
}

/** Full-width search pill above a list. */
function SearchField({
  className,
  label,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & { label: string }) {
  return (
    <label data-slot="search-field" className={cn("ui-search", className)}>
      <Search className="h-[17px] w-[17px] flex-none" strokeWidth={2} aria-hidden="true" />
      <input type="search" aria-label={label} placeholder={label} {...props} />
    </label>
  );
}

/** A number with its unit inside the right edge. Always human units. */
function UnitInput({
  className,
  unit,
  ...props
}: React.ComponentProps<"input"> & { unit: string }) {
  return (
    <span className={cn("relative flex", className)}>
      <InputPrimitive
        data-slot="unit-input"
        inputMode="numeric"
        className="ui-input t-mono pr-[92px]"
        {...props}
      />
      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center border-l border-line-strong px-3.5 text-xs text-fg-3">
        {unit}
      </span>
    </span>
  );
}

/** Plain search box for dense admin tables. */
function SearchInput({ className, ...props }: React.ComponentProps<"input">) {
  return <InputPrimitive data-slot="search-input" type="search" className={cn("ui-input h-10 rounded-full", className)} {...props} />;
}

export { Input, Textarea, SearchField, SearchInput, UnitInput };
