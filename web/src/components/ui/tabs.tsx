"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export interface TabItem<T extends string = string> {
  value: T;
  label: React.ReactNode;
  count?: React.ReactNode;
  href?: string;
  tone?: "danger";
  icon?: React.ReactNode;
}

interface TabsProps<T extends string> {
  value: T;
  items: TabItem<T>[];
  onChange?: (v: T) => void;
  label: string;
  className?: string;
}

/** Sections of a page. Items with an `href` are links, so each tab keeps its own URL. */
export function Tabs<T extends string>({ value, items, onChange, label, className }: TabsProps<T>) {
  return (
    <div role="tablist" aria-label={label} className={cn("ui-tabs", className)}>
      {items.map((item) => {
        const selected = item.value === value;
        const inner = (
          <>
            {item.icon}
            <span>{item.label}</span>
            {item.count !== undefined && item.count !== null ? <span className="count">{item.count}</span> : null}
          </>
        );
        return item.href ? (
          <Link
            key={item.value}
            href={item.href}
            role="tab"
            aria-selected={selected}
            aria-current={selected ? "page" : undefined}
            data-tone={item.tone}
            scroll={false}
          >
            {inner}
          </Link>
        ) : (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={selected}
            data-tone={item.tone}
            onClick={() => onChange?.(item.value)}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: Array<{ value: T; label: React.ReactNode; icon?: React.ReactNode; disabled?: boolean }>;
  onChange: (v: T) => void;
  label: string;
  className?: string;
  /** Items share the width equally. */
  stretch?: boolean;
}

/** Two to four fixed choices that will never grow. */
export function Segmented<T extends string>({ value, options, onChange, label, className, stretch }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn("ui-seg", stretch && "w-full", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(stretch && "flex-1 justify-center")}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface PillsProps<T extends string> {
  value: T;
  options: Array<{ value: T; label: React.ReactNode; count?: React.ReactNode }>;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}

/** A short fixed set of category filters above a list. */
export function Pills<T extends string>({ value, options, onChange, label, className }: PillsProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap gap-1.5 max-[860px]:flex-nowrap max-[860px]:overflow-x-auto", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className="ui-pill"
        >
          {o.label}
          {o.count !== undefined ? <span className="t-mono text-xs font-medium opacity-70">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
