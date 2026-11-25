"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CornerDownLeft, Loader2, Maximize2, Minimize2, MonitorPlay, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Select, type SelectOption } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/page-header";
import { CodeBlock } from "@/components/code-block";
import { NavGuard } from "@/components/nav-guard";
import { formatBytes } from "@/lib/format-bytes";
import { proxyPickerOptions } from "@/lib/proxy-options";
import { buildConnectUrl, maskUrlToken } from "@/lib/connect-url";
import { canSaveToProfile, fetchProfiles, fetchProviders, fetchProxies, fetchSettings, routableProviders, type ProfileMetaItem, type ProviderConfigItem, type ProxySummary } from "@/lib/api";
import { LiveClient, eventModifiers, mouseButton, type FrameMeta } from "@/lib/live-client";
import { useAuthEnabled, useGatewayToken } from "@/components/token-autofill";
import { cn } from "@/lib/utils";

type Status = "idle" | "connecting" | "live" | "error" | "closed";

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const KEEP_ALIVE_OPTIONS: SelectOption[] = Array.from({ length: 20 }, (_, i) => {
  const min = i + 1;
  return { value: String(min * 60), label: `${min} min` };
});
const DEFAULT_KEEP_ALIVE_SECONDS = 300;

const SAVE_TOAST_ID = "profile-save";
const SAVE_CHECK_INTERVAL_MS = 1500;
const SAVE_CHECK_TIMEOUT_MS = 15_000;
const ACTIVITY_LIMIT = 12;

const PROVIDER_BLOCK_CODES = new Set(["ERR_BLOCKED_BY_ADMINISTRATOR", "ERR_BLOCKED_BY_CLIENT"]);

const NAV_BUTTON = "h-8 px-3 text-xs";
const SIDE_TITLE = "m-0 text-[15px] font-bold tracking-[-0.01em]";
const LEAVE_MESSAGE = "A live browser session is open. Leaving this page will end it. Continue?";

interface ActivityEvent {
  at: number;
  text: string;
}

function navErrorText(url: string, reason?: string): string {
  const code = reason?.replace(/^net::/, "");
  if (code && PROVIDER_BLOCK_CODES.has(code)) return `This provider blocks ${url} (${code}).`;
  return `Could not open ${url}${code ? ` (${code})` : ""}.`;
}

function formatMinutesLeft(seconds: number): string {
  if (seconds <= 60) return "<1 min left";
  return `${Math.ceil(seconds / 60)} min left`;
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function PlaygroundPage() {
  const [providers, setProviders] = useState<ProviderConfigItem[] | null>(null);
  const [profiles, setProfiles] = useState<ProfileMetaItem[]>([]);
  const [profilesEnabled, setProfilesEnabled] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [saveProfile, setSaveProfile] = useState<boolean>(true);
  const [proxies, setProxies] = useState<ProxySummary[]>([]);
  const [selectedProxy, setSelectedProxy] = useState<string>("");
  const profileSavable = useMemo(() => {
    const provider = providers?.find((p) => p.id === selectedProvider);
    return !selectedProfile || !provider || canSaveToProfile(provider, selectedProfile);
  }, [providers, selectedProvider, selectedProfile]);
  const [keepAliveSeconds, setKeepAliveSeconds] = useState<number>(DEFAULT_KEEP_ALIVE_SECONDS);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [urlInput, setUrlInput] = useState<string>("https://example.com");
  const [meta, setMeta] = useState<FrameMeta>({
    deviceWidth: DEFAULT_VIEWPORT.width,
    deviceHeight: DEFAULT_VIEWPORT.height,
    scrollX: 0,
    scrollY: 0,
  });
  const lastServerUrlRef = useRef<string>("");
  const urlInputRef = useRef(urlInput);
  useEffect(() => { urlInputRef.current = urlInput; }, [urlInput]);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [navNotice, setNavNotice] = useState<string | null>(null);
  const saveWatchRef = useRef<{ profile: string; saving: boolean; before: string | null; live: boolean } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<LiveClient | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const startedAtRef = useRef(0);
  const log = useCallback((text: string) => {
    const at = startedAtRef.current ? Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000)) : 0;
    setActivity((prev) => [...prev.slice(-(ACTIVITY_LIMIT - 1)), { at, text }]);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let lastW = 0;
    let lastH = 0;
    const sync = () => {
      const w = Math.max(320, Math.floor(el.clientWidth));
      const h = Math.max(240, Math.floor(el.clientHeight));
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      if (clientRef.current?.isOpen()) clientRef.current.setViewport(w, h);
    };
    const schedule = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(sync, 250);
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener("resize", schedule);
    return () => {
      if (pending) clearTimeout(pending);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [status]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen]);

  useEffect(() => {
    if (status !== "live") {
      queueMicrotask(() => setRemainingSeconds(null));
      return;
    }
    queueMicrotask(() => setRemainingSeconds(keepAliveSeconds));
    const tick = setInterval(() => {
      setRemainingSeconds((prev) => (prev === null ? null : Math.max(0, prev - 15)));
    }, 15000);
    return () => clearInterval(tick);
  }, [status, keepAliveSeconds]);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (status !== "live") return;
    const startedAt = Date.now();
    queueMicrotask(() => setElapsedSeconds(0));
    const tick = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(tick);
  }, [status]);

  const authEnabled = useAuthEnabled();
  const realToken = useGatewayToken();

  useEffect(() => {
    fetchProviders()
      .then((r) => {
        const routable = routableProviders(r.providers);
        setProviders(routable);
        if (!selectedProvider && routable.length > 0) {
          setSelectedProvider(routable[0].id);
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
    fetchProxies()
      .then((r) => setProxies(r.proxies))
      .catch(() => setProxies([]));
    fetchSettings()
      .then(({ sessionDefaults }) => {
        if (sessionDefaults.profile) {
          setSelectedProfile(sessionDefaults.profile);
          setSaveProfile(sessionDefaults.saveProfile);
        }
        if (sessionDefaults.proxy) setSelectedProxy(sessionDefaults.proxy);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (canvasRef.current) {
      ctxRef.current = canvasRef.current.getContext("2d", { alpha: false });
    }
  }, []);

  const reportSave = useCallback(() => {
    const watch = saveWatchRef.current;
    saveWatchRef.current = null;
    if (!watch?.live) return;
    if (!watch.saving) {
      toast(`Not saved. ${watch.profile} was opened read-only.`, { id: SAVE_TOAST_ID });
      return;
    }
    toast.loading(`Saving to ${watch.profile}...`, { id: SAVE_TOAST_ID });
    const deadline = Date.now() + SAVE_CHECK_TIMEOUT_MS;
    const check = async (): Promise<void> => {
      const saved = await fetchProfiles()
        .then((r) => r.profiles.find((p) => p.id === watch.profile))
        .catch(() => undefined);
      if (saved && saved.updatedAt !== watch.before) {
        setProfiles((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
        toast.success(`Saved to ${watch.profile} (${formatBytes(saved.sizeBytes)}).`, { id: SAVE_TOAST_ID });
        return;
      }
      if (Date.now() > deadline) {
        toast.error(`No save recorded for ${watch.profile}.`, { id: SAVE_TOAST_ID });
        return;
      }
      setTimeout(() => void check(), SAVE_CHECK_INTERVAL_MS);
    };
    void check();
  }, []);

  const handleStart = useCallback(() => {
    if (!selectedProvider) return;
    if (clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
    }
    startedAtRef.current = Date.now();
    setActivity([]);
    setStatus("connecting");
    setStatusMsg("");
    setNavNotice(null);
    toast.dismiss(SAVE_TOAST_ID);
    lastServerUrlRef.current = "";
    saveWatchRef.current = selectedProfile
      ? {
          profile: selectedProfile,
          saving: saveProfile && profileSavable,
          before: profiles.find((p) => p.id === selectedProfile)?.updatedAt ?? null,
          live: false,
        }
      : null;

    const client = new LiveClient({
      onOpen: () => {
        setStatus("live");
        log(`Browser opened on ${selectedProvider}`);
      },
      onNavError: (url, reason) => {
        setNavNotice(navErrorText(url, reason));
        log(navErrorText(url, reason));
      },
      onRefresh: (state) => setRefreshing(state === "started"),
      onClose: ({ code, reason }) => {
        setRefreshing(false);
        reportSave();
        setStatus("closed");
        setStatusMsg(`connection closed (${code}${reason ? `: ${reason}` : ""})`);
        log("Browser closed");
      },
      onError: (code, message) => {
        setStatus("error");
        setStatusMsg(`${code}: ${message}`);
      },
      onExpiring: (secondsRemaining) => {
        setStatusMsg(`Session ends in ${secondsRemaining}s.`);
      },
      onExpired: () => {
        setStatus("closed");
        setStatusMsg("Session ended after keep-alive limit.");
        log("Session ended when its time ran out");
      },
      onUrl: (url) => {
        setNavNotice(null);
        if (url !== lastServerUrlRef.current) log(`Loaded ${url.replace(/^https?:\/\//, "").replace(/\/$/, "")}`);
        if (urlInputRef.current === lastServerUrlRef.current || lastServerUrlRef.current === "") {
          setUrlInput(url);
        }
        lastServerUrlRef.current = url;
      },
      onFrame: (bitmap, frameMeta) => {
        if (saveWatchRef.current) saveWatchRef.current.live = true;
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
      profile: selectedProfile || "none",
      readOnly: selectedProfile ? !(saveProfile && profileSavable) : undefined,
      proxy: selectedProxy || "none",
      token: authEnabled ? realToken : null,
      maxWidth: DEFAULT_VIEWPORT.width,
      maxHeight: DEFAULT_VIEWPORT.height,
      keepAliveSeconds,
    });
    clientRef.current = client;
  }, [selectedProvider, selectedProfile, saveProfile, profileSavable, profiles, reportSave, authEnabled, realToken, keepAliveSeconds, selectedProxy, log]);

  const handleStop = useCallback(() => {
    if (clientRef.current) log("Session stopped");
    clientRef.current?.close();
    clientRef.current = null;
    setStatus("idle");
    setStatusMsg("");
    setNavNotice(null);
    lastServerUrlRef.current = "";
    setCursorPos(null);
    reportSave();
  }, [reportSave, log]);

  useEffect(
    () => () => {
      clientRef.current?.close();
      clientRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (status !== "live" && status !== "connecting") return;
    const onPageHide = () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [status]);

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

  const lastMoveSent = useRef(0);

  const onCanvasMouseMove = useCallback((ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (status !== "live") return;
    const { x, y } = canvasToFrameCoords(ev);
    setCursorPos({ x, y });
    const now = performance.now();
    if (now - lastMoveSent.current < 33) return;
    lastMoveSent.current = now;
    clientRef.current?.sendMouse({ kind: "move", x, y, modifiers: eventModifiers(ev.nativeEvent) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, meta]);

  // React's onWheel is passive, so preventDefault only works on a listener added with passive: false.
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

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (overlay.width !== meta.deviceWidth) overlay.width = meta.deviceWidth;
    if (overlay.height !== meta.deviceHeight) overlay.height = meta.deviceHeight;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!cursorPos) return;
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
    if (ev.repeat) return;
    const mods = eventModifiers(ev.nativeEvent);

    // The remote machine's clipboard is empty, so a paste shortcut ships the host clipboard text itself.
    const isPasteShortcut =
      ev.key.toLowerCase() === "v" && (ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey;
    if (isPasteShortcut) {
      void navigator.clipboard
        ?.readText()
        .then((text) => clientRef.current?.sendPaste(text))
        .catch(() => {});
      return;
    }

    // With Ctrl/Meta/Alt down, text is omitted so Chrome reads the key as a shortcut.
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

  const providerSelectOptions = useMemo<SelectOption[]>(
    () => (providers ?? []).map((p) => ({ value: p.id, label: p.id })),
    [providers],
  );
  const profileSelectOptions = useMemo<SelectOption[]>(
    () => [{ value: "", label: "None", hint: "Sessions start signed out" }, ...profiles.map((p) => ({ value: p.id, label: p.id }))],
    [profiles],
  );
  const proxySelectOptions = useMemo<SelectOption[]>(
    () => [{ value: "", label: "None", hint: proxies.length === 0 ? "No proxies saved. Add one in Proxies." : undefined }, ...proxyPickerOptions(proxies)],
    [proxies],
  );

  const provider = providers?.find((p) => p.id === selectedProvider);
  const providerAppliesProxy = provider?.injectProxy === true;
  const isLiveOrConnecting = status === "live" || status === "connecting";
  const navDisabled = status !== "live";
  const showCover = status === "idle" || status === "connecting" || status === "error";
  const providerName = selectedProvider || "None";
  const profileName = selectedProfile || "None";
  const noProviders = providers !== null && providers.length === 0;

  const connectParams = [
    selectedProvider ? `provider=${encodeURIComponent(selectedProvider)}` : null,
    selectedProfile ? `profile=${encodeURIComponent(selectedProfile)}` : null,
    selectedProfile && !(saveProfile && profileSavable) ? "readOnly=1" : null,
    selectedProxy ? `proxy=${encodeURIComponent(selectedProxy)}` : null,
    authEnabled && realToken ? `token=${realToken}` : null,
  ].filter(Boolean);
  const connectUrl = `${buildConnectUrl()}${connectParams.length > 0 ? `?${connectParams.join("&")}` : ""}`;
  const snippetFor = (url: string) => `const browser = await puppeteer.connect({\n  browserWSEndpoint:\n    '${url}'\n});`;

  const startButton = (
    <Button variant="primary" className="h-11 px-[22px]" onClick={handleStart} disabled={!selectedProvider || isLiveOrConnecting} loading={status === "connecting"} loadingLabel="Opening">
      Start session
    </Button>
  );

  const setupBar = (
    <section aria-label="Session setup" className="ui-card relative flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[24px] px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        {providerSelectOptions.length > 0 ? (
          <Select label="Provider" value={selectedProvider} options={providerSelectOptions} onChange={setSelectedProvider} disabled={isLiveOrConnecting} footer={{ label: "Manage providers", href: "/providers/" }} />
        ) : (
          <span className="text-xs text-fg-3">{providers === null ? "Loading providers" : "No providers configured."}</span>
        )}
        {profilesEnabled ? (
          <Select label="Profile" value={selectedProfile} options={profileSelectOptions} onChange={setSelectedProfile} disabled={isLiveOrConnecting} footer={{ label: "Manage profiles", href: "/profiles/" }} />
        ) : null}
        <Select label="Proxy" value={selectedProxy} options={proxySelectOptions} onChange={setSelectedProxy} disabled={isLiveOrConnecting} footer={{ label: "Manage proxies", href: "/proxies/" }} />
        <Select label="Length" value={String(keepAliveSeconds)} options={KEEP_ALIVE_OPTIONS} onChange={(v) => setKeepAliveSeconds(Number(v))} disabled={isLiveOrConnecting} />
        {profilesEnabled && selectedProfile ? (
          <span className="flex select-none items-center gap-2 pl-1 text-[13px] font-semibold text-fg-soft">
            <Switch label="Save to profile" checked={saveProfile && profileSavable} onCheckedChange={setSaveProfile} disabled={isLiveOrConnecting || !profileSavable} />
            Save to profile
          </span>
        ) : null}
      </div>
      <span className="flex-[1_1_0]" />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => setIsFullscreen((v) => !v)} aria-label={isFullscreen ? "Exit full screen" : "Full screen"}>
          {isFullscreen ? <Minimize2 strokeWidth={2} /> : <Maximize2 strokeWidth={2} />}
        </Button>
        {isLiveOrConnecting ? (
          <Button variant="destructive-outline" className="bg-bad-bg px-[18px] font-bold" onClick={handleStop}>
            Stop session
          </Button>
        ) : (
          startButton
        )}
      </div>
    </section>
  );

  const browser = (
    <section aria-label="Browser" className={cn("flex min-w-0 flex-col gap-2.5 rounded-[24px] border border-line bg-card p-2.5", isFullscreen ? "min-h-0 flex-1" : "flex-[3_1_640px]")}>
      <form onSubmit={onSubmitUrl} className="flex items-center gap-1.5">
        <Button variant="outline" className={NAV_BUTTON} onClick={() => clientRef.current?.navAction("back")} disabled={navDisabled} aria-label="Back">
          <ArrowLeft strokeWidth={2} />
        </Button>
        <Button variant="outline" className={NAV_BUTTON} onClick={() => clientRef.current?.navAction("forward")} disabled={navDisabled} aria-label="Forward">
          <ArrowRight strokeWidth={2} />
        </Button>
        <Button variant="outline" className={NAV_BUTTON} onClick={() => clientRef.current?.navAction("reload")} disabled={navDisabled} aria-label="Reload">
          <RefreshCw strokeWidth={2} />
        </Button>
        <label htmlFor="playground-address" className="sr-only">
          Page address
        </label>
        <input
          id="playground-address"
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="https://en.wikipedia.org"
          disabled={navDisabled}
          autoComplete="off"
          spellCheck={false}
          className="h-[38px] min-w-0 flex-[1_1_0] rounded-[19px] border border-line-strong bg-ground px-4 font-mono text-[13px] text-fg outline-none placeholder:text-fg-3 focus-visible:border-brand-line disabled:opacity-60"
        />
        <Button type="submit" variant="outline" className={NAV_BUTTON} disabled={navDisabled} aria-label="Go">
          <CornerDownLeft strokeWidth={2} />
        </Button>
      </form>
      <div
        ref={containerRef}
        className={cn("relative overflow-hidden rounded-2xl bg-ground", isFullscreen ? "min-h-0 flex-1" : "h-[620px] max-[860px]:h-[60dvh]")}
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
          className="absolute inset-0 block h-full w-full focus:outline-none"
        />
        <canvas ref={overlayRef} width={DEFAULT_VIEWPORT.width} height={DEFAULT_VIEWPORT.height} className="pointer-events-none absolute inset-0 h-full w-full" />
        {showCover ? (
          <div className="ui-card ui-card--hero absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-2xl border-dashed border-line-strong bg-ground p-6 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-brand-soft text-brand-text">
              {status === "connecting" ? <Loader2 className="size-6 animate-spin" strokeWidth={2} /> : <MonitorPlay className="size-6" strokeWidth={2} />}
            </span>
            <span className="text-lg font-bold">
              {status === "connecting" ? "Opening the browser" : status === "error" ? "The browser did not open" : "No browser open"}
            </span>
            <span className="max-w-[420px] text-sm text-fg-2 [overflow-wrap:anywhere]">
              {status === "connecting"
                ? `Connecting to ${providerName}.`
                : status === "error"
                  ? statusMsg
                  : noProviders
                    ? "Add a provider before starting a live session."
                    : `Pick a profile and proxy above, then start. The browser opens on ${providerName} and closes itself when the time runs out.`}
            </span>
            {status === "connecting" ? null : noProviders ? (
              <Link href="/providers/" className="ui-btn ui-btn--primary h-11 px-[22px]">
                Add a provider
              </Link>
            ) : (
              startButton
            )}
          </div>
        ) : null}
        {status === "live" ? (
          <span className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-24px)] truncate rounded-[10px] bg-[rgba(11,10,16,0.82)] px-2.5 py-[5px] text-[11px] font-semibold text-fg" title={statusMsg || undefined}>
            {statusMsg || "Click the page to control it"}
          </span>
        ) : null}
        {status === "closed" ? (
          <span className="absolute bottom-3 left-3 max-w-[calc(100%-24px)] truncate rounded-[10px] bg-[rgba(11,10,16,0.82)] px-2.5 py-[5px] text-[11px] font-semibold text-fg" title={statusMsg}>
            Session ended{statusMsg ? ` · ${statusMsg}` : ""}
          </span>
        ) : null}
        {navNotice ? (
          <div className="absolute left-3 right-3 top-3 flex items-start gap-2 rounded-[14px] border border-line-strong bg-raised px-3.5 py-2.5 text-xs text-fg">
            <span className="flex-1">{navNotice}</span>
            <button type="button" onClick={() => setNavNotice(null)} className="text-fg-3 hover:text-fg" aria-label="Dismiss">
              <X className="size-3.5" strokeWidth={2} />
            </button>
          </div>
        ) : null}
        {refreshing ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-[rgba(11,10,16,0.6)] text-[13px] text-fg backdrop-blur-sm">
            <Loader2 className="size-4 animate-spin text-fg-3" />
            Updating browser
          </div>
        ) : null}
      </div>
    </section>
  );

  const notices = (
    <>
      {profilesEnabled && selectedProfile && !profileSavable ? (
        <Alert variant="muted">
          {selectedProvider} only serves profile {provider?.profile}. Change it on{" "}
          <Link href="/providers/" className="t-link">
            Providers
          </Link>
          , or pick another provider.
        </Alert>
      ) : null}
      {selectedProxy && !providerAppliesProxy ? (
        <Alert variant="muted">
          {selectedProvider} does not apply proxies. Turn on Apply proxies on{" "}
          <Link href="/providers/" className="t-link">
            Providers
          </Link>
          , or pick another provider.
        </Alert>
      ) : null}
    </>
  );

  return (
    <div className={isFullscreen ? "fixed inset-0 z-50 flex flex-col gap-3 bg-ground p-4" : "contents"}>
      <NavGuard active={isLiveOrConnecting} message={LEAVE_MESSAGE} />
      {isFullscreen ? null : (
        <PageHeader
          title="Playground"
          description="Open a live browser on one of your providers. Click into the page to focus it, then type or click as if it were a local browser."
          actions={<StatusPill status={status} remainingSeconds={remainingSeconds} />}
        />
      )}
      {setupBar}
      {notices}
      <div className={isFullscreen ? "flex min-h-0 flex-1 flex-col" : "flex flex-wrap items-start gap-4"}>
        {browser}
        {isFullscreen ? null : (
        <aside aria-label="This session" className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <section className="ui-card ui-card--corner flex flex-col gap-3 rounded-[24px] p-5">
            <h2 className={SIDE_TITLE}>{status === "live" ? "This session" : "Ready to start"}</h2>
            <div className="grid grid-cols-2 gap-2">
              <SideFact label="Provider" value={providerName} />
              {status === "live" ? (
                <>
                  <SideFact label="Running for" value={formatClock(elapsedSeconds)} />
                  <SideFact label="Profile" value={profileName} />
                  <SideFact label="Proxy" value={selectedProxy || "None"} />
                </>
              ) : (
                <>
                  <SideFact label="Length" value={`${Math.round(keepAliveSeconds / 60)} min`} />
                  <SideFact label="Profile" value={profileName} />
                  <SideFact label="Proxy" value={selectedProxy || "None"} />
                </>
              )}
            </div>
            <span className="text-xs text-fg-3">The session closes itself when the time runs out. Leaving this page ends it.</span>
          </section>
          {activity.length > 0 || status === "live" ? (
            <section className="ui-card flex flex-col gap-2.5 rounded-[24px] p-5">
              <h2 className={SIDE_TITLE}>Activity</h2>
              {activity.length === 0 ? (
                <span className="text-[13px] text-fg-3">Pages you open show here.</span>
              ) : (
                activity.map((e, i) => (
                  <div key={`${e.at}-${i}`} className="flex items-baseline gap-2.5">
                    <span className="w-[34px] flex-none font-mono text-[11px] text-fg-3">{formatClock(e.at)}</span>
                    <span className="min-w-0 text-[13px] text-fg-soft [overflow-wrap:anywhere]">{e.text}</span>
                  </div>
                ))
              )}
            </section>
          ) : null}
          <section className="ui-card flex flex-col gap-2.5 rounded-[24px] p-5">
            <h2 className={SIDE_TITLE}>Same setup from code</h2>
            <CodeBlock code={snippetFor(maskUrlToken(connectUrl))} copyValue={snippetFor(connectUrl)} lang="typescript" filename="puppeteer" />
            <span className="text-xs text-fg-3">
              {authEnabled ? "Copy includes your gateway token. " : null}
              <Link href="/" className="text-xs font-bold text-brand-text hover:underline">
                More examples on Overview →
              </Link>
            </span>
          </section>
        </aside>
        )}
      </div>
    </div>
  );
}

function SideFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-px rounded-2xl border border-line bg-ground px-3 py-2.5">
      <span className="text-[11px] text-fg-3">{label}</span>
      <span className="truncate text-sm font-semibold">{value}</span>
    </div>
  );
}

function StatusPill({ status, remainingSeconds }: { status: Status; remainingSeconds: number | null }) {
  const base = "inline-flex h-10 items-center gap-2 rounded-[20px] px-3.5 text-[13px] font-bold";
  if (status === "live") {
    return (
      <span className={cn(base, "bg-good-bg text-good")}>
        <span className="size-2 animate-pulse rounded-full bg-good" />
        Live
        {remainingSeconds !== null ? (
          <>
            {" ·"}
            <span className="font-mono font-medium">{formatMinutesLeft(remainingSeconds)}</span>
          </>
        ) : null}
      </span>
    );
  }
  if (status === "connecting") {
    return (
      <span className={cn(base, "border border-line-strong text-fg-2")}>
        <Loader2 className="size-3.5 animate-spin" strokeWidth={2.2} />
        Connecting
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className={cn(base, "bg-bad-bg text-bad")}>
        <span className="size-2 rounded-full bg-bad" />
        Error
      </span>
    );
  }
  if (status === "closed") {
    return <span className={cn(base, "border border-line-strong text-fg-2")}>Closed</span>;
  }
  return null;
}
