"use client";

import { useEffect } from "react";

interface NavGuardProps {
  active: boolean;
  message: string;
  onLeave?: () => void;
}

/** Asks before a reload, tab close or in-app link click while `active`. */
export function NavGuard({ active, message, onLeave }: NavGuardProps) {
  useEffect(() => {
    if (!active) return;

    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };

    const clickGuard = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target === "_blank") return;
      if (anchor.hasAttribute("download")) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;

      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;

      const ok = window.confirm(message);
      if (!ok) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      } else {
        onLeave?.();
      }
    };

    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", clickGuard, true);

    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", clickGuard, true);
    };
  }, [active, message, onLeave]);

  return null;
}
