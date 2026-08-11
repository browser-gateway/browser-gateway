"use client";

import { RefObject, useEffect } from "react";

/** Closes an overlay on outside click or Escape when `open` is true. Accepts
 *  one or more refs; the overlay closes only when the click target is outside
 *  ALL of them. Useful when the menu is portaled outside the trigger's
 *  wrapper. */
export function useDismissible(
  open: boolean,
  refs: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const list = Array.isArray(refs) ? refs : [refs];
    function onClick(e: MouseEvent) {
      for (const ref of list) {
        if (ref.current?.contains(e.target as Node)) return;
      }
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, refs]);
}
