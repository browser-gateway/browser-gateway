"use client";

import { Card, CardContent } from "@/components/ui/card";
import { FileText } from "lucide-react";

export default function LogsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Logs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connection history, failover events, and routing decisions.
        </p>
      </div>

      <Card className="glass">
        <CardContent className="px-4 py-12 flex flex-col items-center text-center">
          <FileText className="h-8 w-8 text-muted-foreground/40 mb-3" strokeWidth={1} />
          <p className="text-sm text-muted-foreground">
            Log viewer is coming in a future update.
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1.5">
            The gateway outputs structured JSON logs to your terminal. Check the terminal where you ran <span className="font-mono text-foreground/50">browser-gateway serve</span>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
