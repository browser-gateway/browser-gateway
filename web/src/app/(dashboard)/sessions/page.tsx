"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SessionsResponse, ParkedSessionsResponse } from "@/lib/api";
import { fetchSessions, fetchParkedSessions } from "@/lib/api";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatCountdown(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "expiring";
  if (ms < 60000) return `${Math.ceil(ms / 1000)}s left`;
  return `${Math.ceil(ms / 60000)}m left`;
}

export default function SessionsPage() {
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [parked, setParked] = useState<ParkedSessionsResponse | null>(null);

  useEffect(() => {
    const load = async () => {
      try { setData(await fetchSessions()); } catch {}
      try { setParked(await fetchParkedSessions()); } catch {}
    };
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sessions</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live browser connections routed through the gateway. A dropped session that used a profile is held briefly so it can reconnect and resume.
          </p>
        </div>
        {data && (
          <span className="text-sm font-mono text-muted-foreground tabular-nums shrink-0">
            {data.count} active
          </span>
        )}
      </div>

      <Card className="glass overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-[11px] uppercase tracking-wider h-9">Session</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider h-9">Provider</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider h-9">Profile</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider h-9">Connected</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider h-9">Duration</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider h-9 text-right">Messages</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data || data.count === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="text-center text-[13px] text-muted-foreground py-12">
                    {data ? "No active sessions" : "Loading..."}
                  </TableCell>
                </TableRow>
              ) : (
                data.sessions.map((session) => (
                  <TableRow key={session.id} className="hover:bg-muted/30">
                    <TableCell className="font-mono text-[12px]">
                      {session.id.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-[10px] h-5 px-1.5 font-normal">
                        {session.providerId}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-[12px] text-muted-foreground">
                      {session.profileId ?? "—"}
                    </TableCell>
                    <TableCell className="text-[12px] text-muted-foreground tabular-nums">
                      {new Date(session.connectedAt).toLocaleTimeString()}
                    </TableCell>
                    <TableCell className="font-mono text-[12px] tabular-nums">
                      {formatDuration(session.durationMs)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[12px] tabular-nums">
                      {session.messageCount.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {parked && parked.count > 0 && (
        <div className="space-y-2">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Waiting to reconnect</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              These sessions dropped but are held open so a client can reconnect and pick up where it left off. They are released when the timer runs out.
            </p>
          </div>
          <Card className="glass overflow-hidden">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-[11px] uppercase tracking-wider h-9">Session</TableHead>
                    <TableHead className="text-[11px] uppercase tracking-wider h-9">Provider</TableHead>
                    <TableHead className="text-[11px] uppercase tracking-wider h-9">Messages</TableHead>
                    <TableHead className="text-[11px] uppercase tracking-wider h-9 text-right">Reconnect window</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parked.parked.map((p) => (
                    <TableRow key={p.sessionId} className="hover:bg-muted/30">
                      <TableCell className="font-mono text-[12px]">{p.sessionId.slice(0, 8)}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-mono text-[10px] h-5 px-1.5 font-normal">
                          {p.providerId}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-[12px] tabular-nums text-muted-foreground">
                        {p.messageCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                        {formatCountdown(p.expiresAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
