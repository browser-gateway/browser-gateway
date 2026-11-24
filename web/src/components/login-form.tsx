"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/components/auth-provider";
import { GatewayLogo } from "@/components/gateway-logo";

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
    <div
      className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-4 py-10"
      style={{ backgroundImage: "var(--dots)", backgroundSize: "var(--dot-size)" }}
    >
      <GatewayLogo size={44} />
      <div className="ui-card ui-card--hero animate-fade-in w-full max-w-[440px] p-[26px]">
        <h1 className="t-dialog mb-1.5 text-center">Sign in to browser-gateway</h1>
        <p className="t-sub mb-5 text-center">Enter the token this gateway was started with (BG_TOKEN).</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setError(false);
            }}
            placeholder="BG_TOKEN"
            aria-label="Token"
            autoFocus
            className="t-mono"
          />
          {error ? <p className="text-[13px] text-bad">That token is not right. Check BG_TOKEN and try again.</p> : null}
          <Button type="submit" variant="primary" disabled={!token || loading} className="w-full">
            {loading ? "Signing in" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
