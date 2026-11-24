"use client";

import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { TopBar } from "@/components/top-bar";
import { AuthProvider, useAuth } from "@/components/auth-provider";
import { LoginForm } from "@/components/login-form";
import { Spinner } from "@/components/ui/spinner";

function DashboardContent({ children }: { children: React.ReactNode }) {
  const { loading, authenticated, authRequired } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner size="lg" />
      </div>
    );
  }

  if (authRequired && !authenticated) {
    return <LoginForm />;
  }

  return (
    <div className="ui-shell animate-fade-in">
      <AppSidebar mobileOpen={menuOpen} onMobileClose={() => setMenuOpen(false)} />
      <div className="ui-main">
        <TopBar onOpenMenu={() => setMenuOpen(true)} />
        <main id="main" className="ui-content">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardContent>{children}</DashboardContent>
    </AuthProvider>
  );
}
