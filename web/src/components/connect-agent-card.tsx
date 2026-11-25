"use client";

import * as React from "react";
import { BookOpen, Check, Code2, Copy, Plus, Sparkles } from "lucide-react";
import { Segmented } from "@/components/ui/tabs";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildConnectUrl, maskToken, maskUrlToken } from "@/lib/connect-url";
import { AGENT_CLIENTS, agentPrompt, type AgentClient, type McpSecret } from "@/lib/agent-clients";
import { IntegrationTabs, deriveWsBase } from "./integration-tabs";
import { useAuthEnabled, useGatewayToken } from "./token-autofill";

const SELECTED_KEY = "bg.connect-agent.client";
export const PROMPT_COPIED_KEY = "bg.connect-agent.copied";
export const PROMPT_COPIED_EVENT = "bg:agent-prompt-copied";

function markPromptCopied() {
  try {
    window.localStorage.setItem(PROMPT_COPIED_KEY, "1");
  } catch {
    return;
  } finally {
    window.dispatchEvent(new Event(PROMPT_COPIED_EVENT));
  }
}

function mask(text: string, token: string | null): string {
  return token ? text.split(token).join(maskToken(token)) : text;
}

function useCopy() {
  const [copied, setCopied] = React.useState<string | null>(null);
  const copy = React.useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      setCopied(null);
    }
  }, []);
  return { copied, copy };
}

const selectionListeners = new Set<() => void>();

function subscribeSelection(listener: () => void) {
  selectionListeners.add(listener);
  return () => {
    selectionListeners.delete(listener);
  };
}

function readSelected(): string {
  try {
    const saved = window.localStorage.getItem(SELECTED_KEY);
    if (saved && AGENT_CLIENTS.some((c) => c.id === saved)) return saved;
  } catch {
    return AGENT_CLIENTS[0].id;
  }
  return AGENT_CLIENTS[0].id;
}

function saveSelected(id: string) {
  try {
    window.localStorage.setItem(SELECTED_KEY, id);
  } catch {
    return;
  } finally {
    selectionListeners.forEach((l) => l());
  }
}

function useSelectedClient(): [AgentClient, (id: string) => void] {
  const id = React.useSyncExternalStore(subscribeSelection, readSelected, () => AGENT_CLIENTS[0].id);
  return [AGENT_CLIENTS.find((c) => c.id === id) ?? AGENT_CLIENTS[0], saveSelected];
}

function httpOrigin(): string {
  return deriveWsBase().replace(/^ws/, "http");
}

export function ConnectAgentCard({ agentConnected }: { agentConnected: boolean }) {
  const [mode, setMode] = React.useState<"agents" | "code">("agents");
  const [client, choose] = useSelectedClient();
  const authEnabled = useAuthEnabled();
  const token = useGatewayToken();
  const origin = httpOrigin();
  const waitingForToken = authEnabled && !token;
  const secret: McpSecret = { mcpUrl: `${origin}/mcp`, token: authEnabled ? token : null };

  return (
    <section aria-label="Connect" className="ui-card ui-card--corner flex flex-1 flex-col gap-3.5 rounded-hero p-6 max-[860px]:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[22px] font-bold tracking-[-0.02em]">Connect</h2>
          <span className="flex items-center gap-1.5 text-xs font-semibold text-fg-2">
            <span className={cn("ui-dot", agentConnected ? "ui-dot--good" : "ui-dot--warn")} />
            {agentConnected ? "Sessions are reaching this gateway" : "No sessions yet"}
          </span>
        </div>
        <Segmented
          label="How you connect"
          value={mode}
          onChange={setMode}
          className="rounded-3xl [&>button]:h-[38px] [&>button]:rounded-[19px]"
          options={[
            { value: "agents", label: "AI agents", icon: <Sparkles className="size-[15px]" strokeWidth={2} /> },
            { value: "code", label: "Code", icon: <Code2 className="size-[15px]" strokeWidth={2} /> },
          ]}
        />
      </div>

      {mode === "code" ? (
        <div className="flex flex-col gap-3.5">
          <IntegrationTabs authEnabled={authEnabled} />
          <EndpointLine />
        </div>
      ) : (
        <>
          <div role="group" aria-label="Your agent" className="grid grid-cols-4 gap-2">
            {AGENT_CLIENTS.map((c) => {
              const on = c.id === client.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => choose(c.id)}
                  className={cn(
                    "flex min-w-0 flex-col items-center gap-[7px] rounded-well border px-1 pb-[9px] pt-2.5",
                    on ? "border-brand-text bg-brand-soft" : "border-line bg-raised hover:border-line-strong",
                  )}
                >
                  {c.tile ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.tile} alt="" width={34} height={34} className="block h-[34px] w-[34px] rounded-[10px] shadow-[0_6px_14px_rgba(0,0,0,0.35)]" />
                  ) : (
                    <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-line-strong text-fg-2">
                      <Plus className="size-4" strokeWidth={2} />
                    </span>
                  )}
                  <span className={cn("max-w-full truncate text-xs", on ? "font-bold" : "font-medium")}>{c.name}</span>
                </button>
              );
            })}
          </div>
          {waitingForToken ? (
            <div className="ui-skeleton h-36" />
          ) : (
            <PromptBody key={client.id} client={client} secret={secret} origin={origin} />
          )}
          {agentConnected ? null : (
            <div className="flex items-start gap-2">
              <Sparkles className="mt-px size-4 flex-none text-brand-text" strokeWidth={2} />
              <span className="text-[13px] text-fg-2 [text-wrap:pretty]">
                Then ask your agent: open wikipedia.org and summarise the front page.
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PromptBody({ client, secret, origin }: { client: AgentClient; secret: McpSecret; origin: string }) {
  const { copied, copy } = useCopy();
  const [manual, setManual] = React.useState(false);
  const [full, setFull] = React.useState(false);
  const prompt = agentPrompt(client, secret, origin);

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="overflow-hidden rounded-[18px] border border-line bg-ground">
        <div className="flex items-center gap-2.5 border-b border-line-divider py-2.5 pl-3.5 pr-3">
          {client.tile ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={client.tile} alt="" width={22} height={22} className="block h-[22px] w-[22px] rounded-md" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg-soft">Prompt for {client.name}</span>
          <button
            type="button"
            aria-label={copied === "prompt-icon" ? "Copied" : "Copy the prompt text"}
            onClick={() => {
              void copy("prompt-icon", prompt);
              markPromptCopied();
            }}
            className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[9px] border border-line bg-card text-fg-soft hover:border-line-strong"
          >
            {copied === "prompt-icon" ? <Check className="size-3.5" strokeWidth={2.2} /> : <Copy className="size-3.5" strokeWidth={2} />}
          </button>
        </div>
        <pre
          className={cn(
            "t-mono m-0 whitespace-pre-wrap px-4 pb-4 pt-3.5 text-[13px] leading-[1.6] text-[var(--text-code)] [overflow-wrap:anywhere]",
            !full && "max-h-[150px] overflow-hidden",
          )}
        >
          {mask(prompt, secret.token)}
        </pre>
      </div>
      {manual
        ? client.blocks.map((block) => {
            const text = block.build(secret);
            return (
              <div key={block.label} className="space-y-1.5">
                <p className="text-xs text-fg-3">{block.label}</p>
                <div className="flex items-start gap-2">
                  <pre className="ui-code min-w-0 flex-1 overflow-x-auto px-3.5 py-3">{mask(text, secret.token)}</pre>
                  <Button variant="outline" size="sm" onClick={() => copy(block.label, text)} className="shrink-0">
                    {copied === block.label ? <Check className="h-3.5 w-3.5" strokeWidth={2.25} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />}
                    {copied === block.label ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
            );
          })
        : null}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-3">
        <button type="button" onClick={() => setFull((v) => !v)} aria-expanded={full} className="t-link text-xs">
          {full ? "Show less" : "Show full prompt"}
        </button>
        {client.blocks.length > 0 ? (
          <button type="button" onClick={() => setManual((v) => !v)} aria-expanded={manual} className="t-link text-xs">
            {manual ? "Hide manual setup" : "Manual setup"}
          </button>
        ) : null}
      </p>
      {client.note ? <p className="t-small">{client.note}</p> : null}
      {secret.token ? <p className="t-small">The token is masked on screen. Copy writes the real value.</p> : null}
      <span className="flex-1" />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" className="h-11 flex-[1_1_180px] rounded-[22px] text-sm" onClick={() => {
            void copy("prompt", prompt);
            markPromptCopied();
          }}>
          {copied === "prompt" ? <Check strokeWidth={2.2} /> : <Copy strokeWidth={2.2} />}
          {copied === "prompt" ? "Copied" : "Copy prompt"}
        </Button>
        <a href={client.docsUrl} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "outline" }), "h-11 px-[18px] text-sm")}>
          <BookOpen strokeWidth={2} />
          Setup guide
        </a>
      </div>
    </div>
  );
}

function EndpointLine() {
  const { copied, copy } = useCopy();
  const authEnabled = useAuthEnabled();
  const token = useGatewayToken();
  const full = buildConnectUrl(undefined, authEnabled ? token : null);
  return (
    <div className="flex items-center gap-3">
      <span className="whitespace-nowrap text-xs text-fg-3">Connect URL</span>
      <code className="t-mono min-w-0 flex-1 truncate text-xs text-fg-2">{maskUrlToken(full)}</code>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => copy("endpoint", full)}>
        {copied === "endpoint" ? <Check className="h-3.5 w-3.5" strokeWidth={2.25} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />}
        {copied === "endpoint" ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
