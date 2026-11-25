"use client";

import { usePathname } from "next/navigation";
import { LogOut, Menu } from "lucide-react";
import { NAV_ITEMS } from "./app-sidebar";
import { useAuth } from "./auth-provider";

function pageLabel(pathname: string): string {
  const first = pathname.split("/").filter(Boolean)[0];
  if (!first) return "Overview";
  return NAV_ITEMS.find((item) => item.href === `/${first}/`)?.label ?? first;
}

interface TopBarProps {
  onOpenMenu?: () => void;
}

export function TopBar({ onOpenMenu }: TopBarProps) {
  const pathname = usePathname() ?? "/";
  const { authRequired, logout } = useAuth();
  return (
    <header className="ui-topbar">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open menu"
        className="flex h-10 w-10 flex-none items-center justify-center rounded-full text-fg-2 hover:text-fg min-[861px]:hidden"
      >
        <Menu className="h-[18px] w-[18px]" strokeWidth={1.8} />
      </button>
      <span className="truncate text-sm font-semibold">{pageLabel(pathname)}</span>
      <span className="flex-1" />
      <a
        href="https://github.com/browser-gateway/browser-gateway"
        target="_blank"
        rel="noopener noreferrer"
        className="ui-topbar__pill hidden text-fg-2 min-[861px]:inline-flex"
      >
        GitHub
      </a>
      {authRequired ? (
        <button type="button" onClick={() => void logout()} className="ui-topbar__pill text-fg-2">
          <LogOut className="h-3.5 w-3.5" strokeWidth={1.8} />
          Sign out
        </button>
      ) : null}
    </header>
  );
}
