"use client";

/**
 * Playground page. Live, interactive remote browser view powered by CDP
 * `Page.startScreencast` over WS /v1/live.
 *
 * Flow:
 *   1. User picks a provider + clicks Start
 *   2. We open a WS to /v1/live?provider=...&token=...
 *   3. Server attaches to a page target on that provider, starts the
 *      screencast, forwards binary JPEG frames + JSON control messages
 *   4. Page renders each frame to a canvas, forwards mouse/key events back
 *
 * Spec decisions baked in:
 *   - Required `?provider=<id>` (no auto-routing in v0.3.0)
 *   - Single page target, no multi-tab UI
 *   - No automatic reconnect — user clicks Reconnect manually
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Loader2, Pause, Play, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchProfiles, fetchProviders, type ProfileMetaItem, type ProviderConfigItem } from "@/lib/api";
import { LiveClient, eventModifiers, mouseButton, type FrameMeta } from "@/lib/live-client";
import { useAuthEnabled, useGatewayToken } from "@/components/token-autofill";

type Status = "idle" | "connecting" | "live" | "error" | "closed";

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

export default function PlaygroundPage() {
  const [providers, setProviders] = useState<ProviderConfigItem[] | null>(null);
  const [profiles, setProfiles] = useState<ProfileMetaItem[]>([]);
  const [profilesEnabled, setProfilesEnabled] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [status, setStatus] = useState<Status>("idle");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [urlInput, setUrlInput] = useState<string>("https://example.com");
  const [meta, setMeta] = useState<FrameMeta>({
    deviceWidth: DEFAULT_VIEWPORT.width,
    deviceHeight: DEFAULT_VIEWPORT.height,
    scrollX: 0,
    scrollY: 0,
  });
  // Track the URL the server says the page is on. The input may be in the
  // middle of being typed — we sync it only when the server-reported URL
  // changes AND it doesn't match what the user has typed mid-edit.
  const lastServerUrlRef = useRef<string>("");
  // Last mouse position INSIDE the canvas (in model coords). Used for the
  // cursor overlay. null when the mouse is outside.
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<LiveClient | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const authEnabled = useAuthEnabled();
  const realToken = useGatewayToken();

  // Load provider list.
  useEffect(() => {
    fetchProviders()
      .then((r) => {
        setProviders(r.providers);
        if (!selectedProvider && r.providers.length > 0) {
          setSelectedProvider(r.providers[0].id);
        }
      })
      .catch((err) => {
        setStatus("error");
        setStatusMsg(err instanceof Error ? err.message : String(err));
      });
    fetchProfiles()
      .then((r) => {
        setProfilesEnabled(r.enabled);
        setProfiles(r.profiles);
      })
      .catch(() => {
        setProfilesEnabled(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Acquire canvas context once.
  useEffect(() => {
    if (canvasRef.current) {
      ctxRef.current = canvasRef.current.getContext("2d", { alpha: false });
    }
  }, []);

  const handleStart = useCallback(() => {
    if (!selectedProvider) return;
    if (clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
    }
    setStatus("connecting");
    setStatusMsg("");
    lastServerUrlRef.current = "";

    const client = new LiveClient({
      onOpen: () => setStatus("live"),
      onClose: ({ code, reason }) => {
        setStatus("closed");
        setStatusMsg(`connection closed (${code}${reason ? `: ${reason}` : ""})`);
      },
      onError: (code, message) => {
        setStatus("error");
        setStatusMsg(`${code}: ${message}`);
      },
      onUrl: (url) => {
        // Sync the address bar with the actual page URL unless the user is
        // actively editing (input != the last URL we set).
        if (urlInput === lastServerUrlRef.current || lastServerUrlRef.current === "") {
          setUrlInput(url);
        }
        lastServerUrlRef.current = url;
      },
      onFrame: (bitmap, frameMeta) => {
        setMeta(frameMeta);
        const canvas = canvasRef.current;
        const ctx = ctxRef.current;
        if (!canvas || !ctx) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
      },
    });

    client.connect({
      provider: selectedProvider,
      profile: selectedProfile || undefined,
      token: authEnabled ? realToken : null,
      maxWidth: DEFAULT_VIEWPORT.width,
      maxHeight: DEFAULT_VIEWPORT.height,
    });
    clientRef.current = client;
  }, [selectedProvider, selectedProfile, authEnabled, realToken, urlInput]);

  const handleStop = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
    setStatus("idle");
    setStatusMsg("");
    lastServerUrlRef.current = "";
    setCursorPos(null);
  }, []);

  // Tear down on unmount. Also warn the user when they refresh / close the
  // tab while live — losing the session also means the page they're on
  // disappears server-side (the bridge closes the tab on disconnect).
  useEffect(
    () => () => {
      clientRef.current?.close();
      clientRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (status !== "live") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Required for some browsers to actually show the prompt.
      e.returnValue = "";
    };
    const onPageHide = () => {
      // Last-ditch cleanup: ensure the server-side tab is closed if the
      // browser tears us down without firing unmount.
      clientRef.current?.close();
      clientRef.current = null;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [status]);

  /**
   * Translate a DOM mouse event on the canvas (display coords) to the model
   * coordinates the page is rendered at (frame meta coords). The canvas is
   * displayed scaled-to-fit; the renderer needs viewport-relative pixels.
   *
   * CRITICAL: coords are CLAMPED to [0, deviceW-1] × [0, deviceH-1] so we
   * never send negative or out-of-bounds values to the server (Zod rejects
   * them, which spammed the log). The clamp also keeps the cursor overlay
   * pinned to the canvas edge when the mouse drifts slightly outside.
   */
  function canvasToFrameCoords(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const scaleX = meta.deviceWidth / rect.width;
    const scaleY = meta.deviceHeight / rect.height;
    const rawX = Math.round((ev.clientX - rect.left) * scaleX);
    const rawY = Math.round((ev.clientY - rect.top) * scaleY);
    return {
      x: Math.max(0, Math.min(meta.deviceWidth - 1, rawX)),
      y: Math.max(0, Math.min(meta.deviceHeight - 1, rawY)),
    };
  }

  // mousemove throttle: max ~30 Hz
  const lastMoveSent = useRef(0);

  const onCanvasMouseMove = useCallback((ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (status !== "live") return;
    const { x, y } = canvasToFrameCoords(ev);
    // Update overlay cursor every frame so the user always knows where they are.
    setCursorPos({ x, y });
    // Throttle the network send to ~30 Hz.
    const now = performance.now();
    if (now - lastMoveSent.current < 33) return;
    lastMoveSent.current = now;
    clientRef.current?.sendMouse({ kind: "move", x, y, modifiers: eventModifiers(ev.nativeEvent) });
  }, [status, meta]);

  const onCanvasMouseLeave = useCallback(() => {
    setCursorPos(null);
  }, []);

  const onCanvasMouseDown = useCallback((ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (status !== "live") return;
    canvasRef.current?.focus();
    const { x, y } = canvasToFrameCoords(ev);
    clientRef.current?.sendMouse({
      kind: "press",
      x,
      y,
      button: mouseButton(ev.button),
      clickCount: ev.detail || 1,
      modifiers: eventModifiers(ev.nativeEvent),
    });
  }, [status, meta]);

  const onCanvasMouseUp = useCallback((ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (status !== "live") return;
    const { x, y } = canvasToFrameCoords(ev);
    clientRef.current?.sendMouse({
      kind: "release",
      x,
      y,
      button: mouseButton(ev.button),
      clickCount: ev.detail || 1,
      modifiers: eventModifiers(ev.nativeEvent),
    });
  }, [status, meta]);

  /**
   * Non-passive wheel listener. React's onWheel is passive by default in
   * modern React, so calling preventDefault() in a React handler doesn't
   * actually stop the dashboard from scrolling. We attach the listener via
   * useEffect with `{passive: false}` to get the right behavior.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (ev: WheelEvent) => {
      ev.preventDefault();
      if (status !== "live") return;
      const { x, y } = canvasToFrameCoords(ev);
      clientRef.current?.sendMouse({
        kind: "wheel",
        x,
        y,
        deltaX: ev.deltaX,
        deltaY: ev.deltaY,
        modifiers: eventModifiers(ev),
      });
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, meta]);

  /** Draw the cursor overlay whenever cursorPos changes. */
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (overlay.width !== meta.deviceWidth) overlay.width = meta.deviceWidth;
    if (overlay.height !== meta.deviceHeight) overlay.height = meta.deviceHeight;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!cursorPos) return;
    // A small arrow cursor anchored at (cursorPos.x, cursorPos.y).
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.strokeStyle = "rgba(0,0,0,0.95)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cursorPos.x, cursorPos.y);
    ctx.lineTo(cursorPos.x + 14, cursorPos.y + 14);
    ctx.lineTo(cursorPos.x + 8, cursorPos.y + 14);
    ctx.lineTo(cursorPos.x + 11, cursorPos.y + 22);
    ctx.lineTo(cursorPos.x + 8, cursorPos.y + 23);
    ctx.lineTo(cursorPos.x + 5, cursorPos.y + 16);
    ctx.lineTo(cursorPos.x, cursorPos.y + 20);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }, [cursorPos, meta.deviceWidth, meta.deviceHeight]);

  const onCanvasKeyDown = useCallback((ev: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (status !== "live") return;
    ev.preventDefault();
    if (ev.repeat) return; // suppress browser autorepeat — CDP autoRepeat: false on the receiver
    const mods = eventModifiers(ev.nativeEvent);

    // Cmd+V (mac) / Ctrl+V (others): read the host clipboard and send as a
    // paste message. The native key event reaches Chrome, but Chrome's OS
    // clipboard on the remote machine is empty — so we have to ship the text
    // ourselves. The browser onPaste handler below catches the same intent
    // when the user uses the right-click menu.
    const isPasteShortcut =
      ev.key.toLowerCase() === "v" && (ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey;
    if (isPasteShortcut) {
      // Some browsers / iframes block clipboard.readText() without explicit
      // permission. If it fails, we silently no-op and let the native paste
      // event take over.
      void navigator.clipboard
        ?.readText()
        .then((text) => clientRef.current?.sendPaste(text))
        .catch(() => {});
      return;
    }

    // Printable character with NO modifier keys (other than shift): send text
    // so Chrome injects the character. A separate "char" event would be a
    // duplicate — Chrome already produces the character from the keyDown when
    // `text` is set. With Ctrl/Meta/Alt down, we omit text so the keypress
    // is interpreted as a shortcut, not text input.
    const isShortcut = ev.ctrlKey || ev.metaKey || ev.altKey;
    const printable = ev.key.length === 1 && !isShortcut;
    clientRef.current?.sendKey({
      kind: "down",
      text: printable ? ev.key : undefined,
      code: ev.code,
      key: ev.key,
      keyCode: ev.keyCode,
      modifiers: mods,
    });
  }, [status]);

  const onCanvasPaste = useCallback((ev: React.ClipboardEvent<HTMLCanvasElement>) => {
    if (status !== "live") return;
    ev.preventDefault();
    const text = ev.clipboardData?.getData("text/plain");
    if (text) clientRef.current?.sendPaste(text);
  }, [status]);

  const onCanvasKeyUp = useCallback((ev: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (status !== "live") return;
    ev.preventDefault();
    clientRef.current?.sendKey({
      kind: "up",
      code: ev.code,
      key: ev.key,
      keyCode: ev.keyCode,
      modifiers: eventModifiers(ev.nativeEvent),
    });
  }, [status]);

  const onSubmitUrl = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!urlInput || status !== "live") return;
      const normalized = /^https?:\/\//i.test(urlInput) ? urlInput : `https://${urlInput}`;
      clientRef.current?.navigate(normalized);
    },
    [urlInput, status],
  );

  const providerOptions = useMemo(() => providers ?? [], [providers]);
  const profileOptions = useMemo(() => profiles ?? [], [profiles]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Playground</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Live remote browser view. Pick a provider, click Start, then click and type into the canvas as if it were a local browser.
        </p>
      </div>

      <Card className="glass border-border/40">
        <CardContent className="px-5 py-4 space-y-4">
          {/* Top control bar: provider + profile + status + start/stop */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-[12px] font-medium text-foreground/80 shrink-0">Provider</label>
              <select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                disabled={status === "live" || status === "connecting"}
                className="bg-muted/30 border border-border/40 rounded h-10 px-3.5 text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-foreground/40 disabled:opacity-50"
              >
                {providerOptions.length === 0 && <option value="">(no providers)</option>}
                {providerOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.id}</option>
                ))}
              </select>
            </div>

            {profilesEnabled && (
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-foreground/80 shrink-0">Profile</label>
                <select
                  value={selectedProfile}
                  onChange={(e) => setSelectedProfile(e.target.value)}
                  disabled={status === "live" || status === "connecting"}
                  className="bg-muted/30 border border-border/40 rounded h-10 px-3.5 text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-foreground/40 disabled:opacity-50"
                >
                  <option value="">(no profile)</option>
                  {profileOptions.map((p) => (
                    <option key={p.id} value={p.id}>{p.id}</option>
                  ))}
                </select>
              </div>
            )}

            <StatusBadge status={status} message={statusMsg} />

            <div className="ml-auto flex items-center gap-2">
              {status === "live" || status === "connecting" ? (
                <Button variant="outline" onClick={handleStop} size="sm">
                  <Pause className="size-3.5 mr-1.5" />
                  Stop
                </Button>
              ) : (
                <Button onClick={handleStart} size="sm" disabled={!selectedProvider}>
                  <Play className="size-3.5 mr-1.5" />
                  Start
                </Button>
              )}
            </div>
          </div>

          {/* Address bar — visible whenever a session is open */}
          {(status === "live" || status === "connecting" || status === "closed") && (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon-sm" onClick={() => clientRef.current?.navAction("back")} title="Back" disabled={status !== "live"}>
                <ArrowLeft className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => clientRef.current?.navAction("forward")} title="Forward" disabled={status !== "live"}>
                <ArrowRight className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => clientRef.current?.navAction("reload")} title="Reload" disabled={status !== "live"}>
                <RefreshCw className="size-3.5" />
              </Button>
              <form onSubmit={onSubmitUrl} className="flex-1 flex items-center gap-2">
                <Input
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://example.com"
                  className="font-mono text-[13px]"
                  disabled={status !== "live"}
                />
                <Button type="submit" variant="secondary" size="sm" disabled={status !== "live"}>
                  Go
                </Button>
              </form>
            </div>
          )}

          {/*
            Canvas wrapper. Stacks the screencast canvas + the cursor overlay so
            the cursor draws on top without affecting input. `overscroll-contain`
            prevents wheel scroll inside the canvas from chaining out to the
            page. `touch-none` blocks touch-scroll on mobile/trackpads.
          */}
          <div
            className="relative rounded-lg border border-border/40 bg-black/40 overflow-hidden"
            style={{ overscrollBehavior: "contain", touchAction: "none" }}
          >
            <canvas
              ref={canvasRef}
              tabIndex={0}
              width={DEFAULT_VIEWPORT.width}
              height={DEFAULT_VIEWPORT.height}
              onMouseMove={onCanvasMouseMove}
              onMouseLeave={onCanvasMouseLeave}
              onMouseDown={onCanvasMouseDown}
              onMouseUp={onCanvasMouseUp}
              onContextMenu={(e) => e.preventDefault()}
              onKeyDown={onCanvasKeyDown}
              onKeyUp={onCanvasKeyUp}
              onPaste={onCanvasPaste}
              className="w-full block bg-black focus:outline-none"
              style={{ aspectRatio: `${meta.deviceWidth} / ${meta.deviceHeight}` }}
            />
            <canvas
              ref={overlayRef}
              width={DEFAULT_VIEWPORT.width}
              height={DEFAULT_VIEWPORT.height}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ aspectRatio: `${meta.deviceWidth} / ${meta.deviceHeight}` }}
            />
          </div>

          {status === "idle" && (
            <p className="text-[12px] text-muted-foreground">
              Click <em className="not-italic font-medium text-foreground">Start</em> to open a live browser on the selected provider. Click into the canvas to focus it before typing.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status, message }: { status: Status; message: string }) {
  const labelMap: Record<Status, string> = {
    idle: "Not connected",
    connecting: "Connecting",
    live: "Live",
    closed: "Closed",
    error: "Error",
  };
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span
        className={`inline-block size-2 rounded-full ${
          status === "live" ? "bg-foreground" :
          status === "connecting" ? "bg-muted-foreground animate-pulse" :
          status === "error" ? "bg-destructive" :
          "bg-muted-foreground/40"
        }`}
      />
      <span className="text-foreground">{labelMap[status]}</span>
      {status === "connecting" && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      {message && (
        <span className="text-muted-foreground font-mono text-[11px]" title={message}>
          · {message.length > 60 ? `${message.slice(0, 60)}…` : message}
        </span>
      )}
    </div>
  );
}
