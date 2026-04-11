import { z } from "zod";
import type { Browser, BrowserContext, Page } from "playwright-core";

export const PoolConfigSchema = z.object({
  minSessions: z.number().int().min(0).default(0),
  maxSessions: z.number().int().min(1).default(5),
  maxPagesPerSession: z.number().int().min(1).default(10),
  retireAfterPages: z.number().int().min(1).default(100),
  retireAfterMs: z.number().int().min(10000).default(3600000),
  idleTimeoutMs: z.number().int().min(5000).default(300000),
  pageTimeoutMs: z.number().int().min(1000).default(30000),
});

export type PoolConfig = z.infer<typeof PoolConfigSchema>;

export type SessionState = "starting" | "active" | "retiring" | "closed";

export interface PoolSession {
  id: string;
  browser: Browser;
  state: SessionState;
  activePages: number;
  totalPagesServed: number;
  createdAt: number;
  lastActivity: number;
}

export interface PageHandle {
  id: string;
  page: Page;
  context: BrowserContext;
  sessionId: string;
  acquiredAt: number;
}

export interface PoolStatus {
  totalSessions: number;
  activeSessions: number;
  retiringSessions: number;
  totalActivePages: number;
  config: PoolConfig;
  sessions: Array<{
    id: string;
    state: SessionState;
    activePages: number;
    totalPagesServed: number;
    uptime: number;
  }>;
}
