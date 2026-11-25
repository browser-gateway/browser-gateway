"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  Server,
  Globe,
  Plug,
  SquareTerminal,
  Play,
  CircleUser,
  ScrollText,
  Zap,
  SlidersHorizontal,
  FileCode2,
  BookOpen,
  ExternalLink,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { GatewayLogo } from "./gateway-logo";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/providers/", label: "Providers", icon: Server },
  { href: "/proxies/", label: "Proxies", icon: Globe },
  { href: "/sessions/", label: "Sessions", icon: Plug },
  { href: "/profiles/", label: "Profiles", icon: CircleUser },
  { href: "/playground/", label: "Playground", icon: Play },
  { href: "/api/", label: "REST API", icon: SquareTerminal },
  { href: "/webhooks/", label: "Webhooks", icon: Zap },
  { href: "/logs/", label: "Logs", icon: ScrollText },
  { href: "/settings/", label: "Settings", icon: SlidersHorizontal },
  { href: "/config/", label: "Config", icon: FileCode2 },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href);
}

interface AppSidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function AppSidebar({ mobileOpen = false, onMobileClose }: AppSidebarProps) {
  const pathname = usePathname() ?? "/";

  const body = (
    <>
      <Link href="/" className="mb-2 flex items-center gap-2.5 border-b border-line-faint px-2 pb-3 pt-1.5">
        <GatewayLogo size={26} className="h-[26px] w-[26px] shrink-0" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-bold">browser-gateway</span>
          <span className="t-mono text-[10.5px] text-fg-3">v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
        </span>
      </Link>
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className="ui-nav"
            aria-current={isActive(pathname, item.href) ? "page" : undefined}
          >
            <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
      <div className="mt-auto flex flex-col gap-0.5 pt-3">
        <a href="https://docs.browsergateway.com" target="_blank" rel="noopener noreferrer" className="ui-nav">
          <BookOpen className="h-4 w-4 shrink-0" strokeWidth={1.8} />
          <span className="flex-1 truncate">Docs</span>
          <ExternalLink className="h-3 w-3 shrink-0 text-fg-3" strokeWidth={1.8} />
        </a>
      </div>
    </>
  );

  return (
    <>
      <nav aria-label="Main" className="ui-sidebar sticky top-0 h-screen overflow-y-auto">
        {body}
      </nav>
      {mobileOpen ? (
        <div className="fixed inset-0 z-[85] min-[861px]:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0"
            style={{ background: "var(--scrim)" }}
            onClick={onMobileClose}
          />
          <nav
            aria-label="Main"
            className="ui-sidebar"
            data-drawer="true"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a")) onMobileClose?.();
            }}
          >
            {body}
          </nav>
        </div>
      ) : null}
    </>
  );
}
