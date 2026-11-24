"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChipInputProps {
  id?: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  max?: number;
  className?: string;
}

/** A well of removable chips with an input at the end. Enter, comma or leaving the box adds one; Backspace on an empty box removes the last. */
function ChipInput({ id, value, onChange, placeholder, max = 100, className }: ChipInputProps) {
  const [draft, setDraft] = React.useState("");

  function commit(raw: string) {
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const part of parts) if (!next.includes(part) && next.length < max) next.push(part);
    onChange(next);
    setDraft("");
  }

  return (
    <div
      className={cn(
        "flex min-h-[46px] w-full flex-wrap items-center gap-1.5 rounded-input border border-line-strong bg-ground px-2.5 py-2 focus-within:border-brand-text",
        className,
      )}
    >
      {value.map((chip) => (
        <span key={chip} className="ui-chip t-mono bg-raised pr-1 font-medium">
          <span className="truncate">{chip}</span>
          <button
            type="button"
            aria-label={`Remove ${chip}`}
            onClick={() => onChange(value.filter((v) => v !== chip))}
            className="inline-flex h-4 w-4 items-center justify-center rounded text-fg-3 hover:text-fg"
          >
            <X className="h-3 w-3" strokeWidth={2.2} />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => {
          if (e.target.value.includes(",")) commit(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? placeholder : undefined}
        autoComplete="off"
        spellCheck={false}
        className="t-mono h-7 min-w-24 flex-1 bg-transparent px-1.5 text-sm outline-none"
      />
    </div>
  );
}

export { ChipInput };
