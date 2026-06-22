"use client";

/**
 * "New Profile" dialog — explicit create flow.
 *
 *   1. User types a profile id
 *   2. Real-time validation (matches PROFILE_ID_REGEX)
 *   3. Live preview of the WS connect URL with the token MASKED on screen
 *      (real token used in the copy button via `copyValue`)
 *   4. "Create profile" hits POST /v1/profiles/create which writes an empty
 *      blob so the row appears in the list immediately. Without this users
 *      were confused by the implicit "first connect creates it" workflow.
 *
 * The Puppeteer example that used to live here was removed to keep the modal
 * compact (no internal scroll allowed per CLAUDE.md rule 17). Examples live in
 * the page's "How profiles work" collapsible.
 */
import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { buildConnectUrl, maskUrlToken, validateProfileId } from "@/lib/connect-url";
import { createProfile } from "@/lib/api";
import { useGatewayToken } from "./token-autofill";

interface NewProfileDialogProps {
  /** Reflects login state — controls whether `&token=` is appended. */
  authEnabled?: boolean;
  /** Called after a successful create so the parent can refresh its list. */
  onCreated?: () => void;
  triggerLabel?: string;
}

type Status = "idle" | "creating" | "created" | "error";

export function NewProfileDialog({ authEnabled, onCreated, triggerLabel = "New Profile" }: NewProfileDialogProps) {
  const realToken = useGatewayToken();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [validationErr, setValidationErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [serverErr, setServerErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setId("");
        setValidationErr(null);
        setCopied(false);
        setStatus("idle");
        setServerErr(null);
      }, 200);
    }
  }, [open]);

  function handleChange(next: string) {
    setId(next);
    setStatus("idle");
    setServerErr(null);
    if (next === "") {
      setValidationErr(null);
      return;
    }
    const r = validateProfileId(next);
    setValidationErr(r.ok ? null : r.reason);
  }

  const realUrl = id && !validationErr ? buildConnectUrl(id, authEnabled ? realToken : null) : "";
  const displayUrl = realUrl ? maskUrlToken(realUrl) : "";

  async function handleCopy() {
    if (!realUrl) return;
    try {
      await navigator.clipboard.writeText(realUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may be unavailable
    }
  }

  async function handleCreate() {
    if (!id || validationErr) return;
    setStatus("creating");
    setServerErr(null);
    try {
      await createProfile(id);
      setStatus("created");
      onCreated?.();
      // Close shortly after success so the user sees the confirmation flash.
      setTimeout(() => setOpen(false), 900);
    } catch (e) {
      setServerErr(e instanceof Error ? e.message : "Create failed");
      setStatus("error");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="size-3.5 mr-1.5" />
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a new profile</DialogTitle>
          <DialogDescription>
            Pick an id. Creating it writes an empty profile so the row appears in the list immediately — the first session that connects with this id fills it with real cookies and storage on disconnect.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 min-w-0">
          <div className="space-y-1.5">
            <label htmlFor="profile-id" className="text-[12px] font-medium text-foreground/80">
              Profile id
            </label>
            <Input
              id="profile-id"
              value={id}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && id && !validationErr && status === "idle") handleCreate();
              }}
              placeholder="e.g. acme-prod, internal-staging"
              autoFocus
              className="font-mono text-[13px]"
              aria-invalid={!!validationErr}
              aria-describedby={validationErr ? "profile-id-error" : undefined}
            />
            {validationErr && (
              <p id="profile-id-error" className="text-[12px] text-destructive">
                {validationErr}
              </p>
            )}
          </div>

          {realUrl && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[12px] font-medium text-foreground/80">
                  Connect URL
                </label>
                <Button size="sm" variant="ghost" onClick={handleCopy} className="h-6 px-2 text-[11px]">
                  {copied ? (
                    <><Check className="size-3 mr-1" />copied</>
                  ) : (
                    <><Copy className="size-3 mr-1" />copy</>
                  )}
                </Button>
              </div>
              <code className="block bg-black/40 border border-border/40 rounded px-3 py-2 font-mono text-[11.5px] text-foreground/90 break-all">
                {displayUrl}
              </code>
              {authEnabled && (
                <p className="text-[11px] text-muted-foreground">
                  Token shown masked — Copy writes the real value.
                </p>
              )}
            </div>
          )}

          {serverErr && (
            <p className="text-[12px] text-destructive px-1">{serverErr}</p>
          )}
          {status === "created" && (
            <p className="text-[12px] text-foreground px-1">
              <Check className="size-3 inline mr-1" />
              Profile created — closing…
            </p>
          )}
        </div>

        <DialogFooter className="flex-row sm:flex-row gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(false)}
            className="flex-1 sm:flex-none"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!id || !!validationErr || status === "creating" || status === "created"}
            onClick={handleCreate}
            className="flex-1 sm:flex-none"
          >
            {status === "creating" ? (
              <><Loader2 className="size-3.5 mr-1.5 animate-spin" />Creating…</>
            ) : status === "created" ? (
              <><Check className="size-3.5 mr-1.5" />Created</>
            ) : (
              <><Plus className="size-3.5 mr-1.5" />Create profile</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
