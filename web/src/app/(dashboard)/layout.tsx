"use client";

import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { AuthProvider, useAuth } from "@/components/auth-provider";
import { LoginForm } from "@/components/login-form";

function DashboardContent({ children }: { children: React.ReactNode }) {
  const { loading, authenticated, authRequired } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-5 w-5 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin" />
      </div>
    );
  }

  if (authRequired && !authenticated) {
    return <LoginForm />;
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-6">
          <SidebarTrigger className="-ml-1 h-7 w-7 text-muted-foreground hover:text-foreground" />
          <Separator orientation="vertical" className="!h-4 mr-2" />
          <span className="text-sm text-muted-foreground">Monitor</span>
        </header>
        <main className="flex-1 px-8 py-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardContent>{children}</DashboardContent>
    </AuthProvider>
  );
}
