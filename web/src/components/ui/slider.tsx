"use client";

import * as React from "react";
import { Slider as BaseSlider } from "@base-ui/react/slider";
import { cn } from "@/lib/utils";

interface SliderProps {
  value: number;
  onValueChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

export function Slider({
  value,
  onValueChange,
  min = 1,
  max = 100,
  step = 1,
  disabled,
  className,
  "aria-label": ariaLabel,
}: SliderProps) {
  return (
    <BaseSlider.Root
      value={value}
      onValueChange={(v) => onValueChange(Array.isArray(v) ? v[0] : v)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn("relative flex w-full items-center py-2", className)}
    >
      <BaseSlider.Control className="relative flex h-4 w-full items-center">
        <BaseSlider.Track className="relative h-1 w-full rounded-full bg-muted">
          <BaseSlider.Indicator className="absolute h-full rounded-full bg-foreground" />
        </BaseSlider.Track>
        <BaseSlider.Thumb
          aria-label={ariaLabel}
          className="block h-4 w-4 rounded-full border border-foreground bg-background shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 disabled:opacity-50"
        />
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
