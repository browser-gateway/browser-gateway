"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/auth-provider";

export function LoginForm() {
  const { login } = useAuth();
  const [token, setToken] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(false);
    setLoading(true);

    const ok = await login(token);
    if (!ok) setError(true);
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm glass">
        <CardContent className="px-6 py-8">
          <div className="flex flex-col items-center mb-6">
            <div className="flex h-8 w-8 items-center justify-center rounded bg-foreground text-background text-xs font-bold mb-3">
              BG
            </div>
            <p className="text-[15px] font-semibold tracking-tight">browser-gateway</p>
            <p className="text-[12px] text-muted-foreground mt-0.5">Enter your token to continue</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="password"
              value={token}
              onChange={(e) => { setToken(e.target.value); setError(false); }}
              placeholder="BG_TOKEN"
              autoFocus
              className="w-full h-9 px-3 text-[13px] rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
            />

            {error && (
              <p className="text-[12px] text-destructive">Invalid token</p>
            )}

            <Button
              type="submit"
              disabled={!token || loading}
              className="w-full h-9 text-[13px]"
            >
              {loading ? "Authenticating..." : "Continue"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
