"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, Server, Plug, FileText, Settings, ExternalLink } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";

const navItems = [
  { title: "Overview", href: "/", icon: LayoutGrid },
  { title: "Providers", href: "/providers/", icon: Server },
  { title: "Sessions", href: "/sessions/", icon: Plug },
  { title: "Logs", href: "/logs/", icon: FileText },
  { title: "Config", href: "/config/", icon: Settings },
];

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <Sidebar className="border-r border-sidebar-border">
      <SidebarHeader className="px-4 py-5">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background text-[11px] font-bold">
            BG
          </div>
          <span className="text-sm font-semibold tracking-tight">
            browser-gateway
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent className="px-3">
        <SidebarGroup className="py-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      render={<Link href={item.href} />}
                      isActive={pathname === item.href}
                      className="h-9 px-3 text-sm font-normal"
                    >
                      <Icon className="!h-4 !w-4" strokeWidth={1.5} />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-4 py-4">
        <div className="flex items-center justify-between">
          <a
            href="https://browsergateway.io"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            browsergateway.io
            <ExternalLink className="h-3 w-3" />
          </a>
          <ThemeToggle />
        </div>
        <p className="text-[11px] text-muted-foreground/50 font-mono mt-1">v0.1.6</p>
      </SidebarFooter>
    </Sidebar>
  );
}
