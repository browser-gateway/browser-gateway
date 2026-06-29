"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { restartGateway, waitForGatewayHealth } from "@/lib/api";

interface RestartDialogProps {
  open: boolean;
  title?: string;
  description?: string;
  onClose: () => void;
}

type Phase = "confirm" | "restarting" | "polling" | "done" | "timeout" | "error";

export function RestartDialog({ open, title, description, onClose }: RestartDialogProps) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPhase("confirm");
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  async function trigger() {
    setPhase("restarting");
    setError(null);
    try {
      await restartGateway();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      return;
    }
    setPhase("polling");
    await new Promise((r) => setTimeout(r, 2_000));
    const ok = await waitForGatewayHealth(30_000);
    if (ok) {
      setPhase("done");
      setTimeout(() => window.location.reload(), 500);
    } else {
      setPhase("timeout");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold">{title ?? "Restart Gateway"}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {description ?? "The gateway will restart now. Active sessions disconnect. The dashboard reloads when the gateway is back."}
            </p>
          </div>

          {phase === "confirm" && (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                Self-restart works when the gateway runs under a supervisor (Docker, Railway, Render, Fly, systemd). Without a supervisor, restart manually after exit.
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={trigger}>Restart now</Button>
              </div>
            </div>
          )}

          {(phase === "restarting" || phase === "polling") && (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {phase === "restarting" ? "Sending restart signal..." : "Waiting for gateway to come back..."}
            </div>
          )}

          {phase === "done" && (
            <div className="text-sm text-foreground">Gateway is back. Reloading...</div>
          )}

          {phase === "timeout" && (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                The gateway did not come back within 30 seconds. If no supervisor is running, restart the process manually.
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={onClose}>Close</Button>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="space-y-3">
              <div className="text-sm text-destructive">Restart failed: {error}</div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={onClose}>Close</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
