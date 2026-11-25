"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, CircleUser, KeyRound, Link2, Lock, Plus, Star, Upload } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-row";
import { DataChip, StatusBadge } from "@/components/ui/badge";
import { Dialog, DialogActions, DialogHeader } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { RowMenu } from "@/components/ui/row-menu";
import { Segmented } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProfileListResponse, ProfileMetaItem } from "@/lib/api";
import {
  deleteProfile,
  disableProfiles,
  exportProfileUrl,
  fetchProfiles,
  fetchSettings,
  importProfile,
  importProfilePlaywright,
} from "@/lib/api";
import { IntegrationTabs } from "@/components/integration-tabs";
import { NewProfileDialog, type NewProfileMode } from "@/components/new-profile-dialog";
import { RestartNotice } from "@/components/restart-notice";
import { SetupEncryptionKeyDialog } from "@/components/setup-encryption-key-dialog";
import { useGatewayToken, useAuthEnabled } from "@/components/token-autofill";
import { buildConnectUrl } from "@/lib/connect-url";
import { formatBytes } from "@/lib/format-bytes";

const REFRESH_MS = 5000;
const LARGE_PROFILE_BYTES = 5 * 1024 * 1024;

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const ageMs = Date.now() - d.getTime();
  if (ageMs < 60_000) return "just now";
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function derivePlaywrightId(fileName: string): string {
  return fileName
    .replace(/\.storagestate\.json$|\.json$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
}

export default function ProfilesPage() {
  const [data, setData] = useState<ProfileListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [defaultProfile, setDefaultProfile] = useState<string | null | undefined>(undefined);
  const [dialogMode, setDialogMode] = useState<NewProfileMode>("empty");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<ProfileMetaItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableBusy, setDisableBusy] = useState(false);
  const [restartNotice, setRestartNotice] = useState<string | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  const authEnabled = useAuthEnabled();
  const realToken = useGatewayToken();

  const reload = useCallback(async () => {
    try {
      setData(await fetchProfiles());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load profiles.");
    }
  }, []);

  useEffect(() => {
    const t0 = setTimeout(() => void reload(), 0);
    fetchSettings()
      .then((s) => setDefaultProfile(s.sessionDefaults.profile))
      .catch(() => setDefaultProfile(null));
    const t = setInterval(() => void reload(), REFRESH_MS);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [reload]);

  function openDialog(mode: NewProfileMode) {
    setDialogMode(mode);
    setDialogOpen(true);
  }

  async function handleImport(file: File) {
    const isJson = file.type.includes("json") || file.name.toLowerCase().endsWith(".json");
    if (isJson) {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("File is not valid JSON.");
      }
      const looksPlaywrightObject =
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Array.isArray((parsed as { cookies?: unknown }).cookies);
      if (!looksPlaywrightObject && !Array.isArray(parsed)) {
        throw new Error(
          "JSON did not look like a Playwright storageState or a cookie array. For encrypted profile files, upload the .bgp file.",
        );
      }
      const id = derivePlaywrightId(file.name);
      if (!id) {
        throw new Error(`A profile ID cannot be made from "${file.name}". Rename it, for example github.storagestate.json.`);
      }
      const result = await importProfilePlaywright(id, parsed);
      toast.success(`Imported ${result.imported}.`, { description: `${formatBytes(result.bytes)} from a Playwright file.` });
    } else {
      const result = await importProfile(file);
      toast.success(`Imported ${result.imported}.`, { description: formatBytes(result.bytes) });
    }
    await reload();
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteProfile(deleting.id);
      toast.success(`Deleted ${deleting.id}.`);
      setDeleting(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }

  async function confirmDisable() {
    setDisableBusy(true);
    try {
      const r = await disableProfiles();
      if (r.restartRequired) setRestartNotice("Profiles turned off in gateway.yml.");
      setDisableOpen(false);
    } catch (e: unknown) {
      toast.error(`Turning off profiles failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDisableBusy(false);
    }
  }

  const enabled = data?.enabled ?? true;
  const profiles = data?.profiles ?? [];

  return (
    <>
      <PageHeader
        title="Profiles"
        description="Reusable logins for your sessions. Cookies and site storage are saved when a session ends and loaded on the next one with the same ID, encrypted at rest."
        actions={
          data && enabled ? (
            <>
              <Link href="/settings" className="ui-btn">
                Session defaults
              </Link>
              <Button variant="outline" onClick={() => openDialog("import")}>
                <Upload strokeWidth={2} />
                Import
              </Button>
              <Button variant="accent" className="px-[18px]" onClick={() => openDialog("empty")}>
                <Plus strokeWidth={2.4} />
                New profile
              </Button>
            </>
          ) : null
        }
      />

      {restartNotice ? <RestartNotice message={restartNotice} /> : null}

      {data && !enabled ? (
        <section aria-label="Enable profiles" className="ui-card ui-card--hero flex flex-col items-start gap-3 rounded-[28px] px-7 py-8">
          <span className="ui-iconcircle size-[52px]">
            <KeyRound className="size-[22px]" strokeWidth={2} aria-hidden="true" />
          </span>
          <h2 className="m-0 text-2xl font-bold leading-[1.2] tracking-[-0.02em]">Profiles are not enabled on this gateway</h2>
          <span className="max-w-[620px] text-[15px] text-fg-2">
            Profiles save cookies and site storage between sessions, encrypted at rest. Enabling them makes an encryption key in your
            browser, then writes it to <span className="t-mono">.env</span> and turns on the profiles block in{" "}
            <span className="t-mono">gateway.yml</span>, or gives you the snippets to do it by hand. Restart the gateway afterwards.
          </span>
          <div className="mt-1">
            <SetupEncryptionKeyDialog />
          </div>
        </section>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(250px,100%),1fr))] gap-3">
            <InfoCard icon={<Lock className="size-4" strokeWidth={2} />} title="Encrypted at rest">
              <span className="text-xs text-fg-3">Cookies and storage are unreadable without the gateway&apos;s key.</span>
            </InfoCard>
            <InfoCard icon={<Link2 className="size-4" strokeWidth={2} />} title="Pass it on the connect URL" gap="gap-1">
              <DataChip mono className="w-fit">
                profile=&lt;id&gt;
              </DataChip>
            </InfoCard>
            <InfoCard
              icon={<Star className="size-4" strokeWidth={2} />}
              title={`Default profile: ${defaultProfile === undefined ? "" : (defaultProfile ?? "None")}`}
              href="/settings"
              quiet
            >
              <span className="text-xs text-fg-3">Sessions without a profile on the URL start with the default. Change it in Settings.</span>
            </InfoCard>
          </div>

          {!data && !loadError ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(460px,100%),1fr))] gap-4">
              <Skeleton className="h-[300px] rounded-card" />
              <Skeleton className="h-[300px] rounded-card" />
            </div>
          ) : loadError && !data ? (
            <Alert title="Profiles did not load">
              {loadError}{" "}
              <button type="button" className="t-link" onClick={() => void reload()}>
                Retry
              </button>
            </Alert>
          ) : profiles.length === 0 ? (
            <EmptyState
              className="ui-card--hero"
              icon={CircleUser}
              title="No profiles yet"
              hint="Add profile=<id> to the connect URL and one is saved when the session ends. Or reserve an ID up front. Saved profiles show here."
              action={
                <Button variant="primary" onClick={() => openDialog("empty")}>
                  New profile
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(460px,100%),1fr))] gap-4">
              {profiles.map((p) => (
                <ProfileCard
                  key={p.id}
                  profile={p}
                  isDefault={p.id === defaultProfile}
                  connectUrl={(readOnly) => buildConnectUrl(p.id, authEnabled ? realToken : null, readOnly)}
                  onDelete={() => setDeleting(p)}
                />
              ))}
            </div>
          )}

          {data ? (
            <Card variant="plain" className="flex flex-col gap-0 p-0">
              <button
                type="button"
                onClick={() => setHowOpen((v) => !v)}
                aria-expanded={howOpen}
                aria-controls="profiles-howto"
                className="flex w-full items-center justify-between gap-3 px-[22px] py-4 text-left"
              >
                <span className="t-h3">How profiles work, with client examples</span>
                <ChevronDown
                  className={`size-4 flex-none text-fg-3 transition-transform ${howOpen ? "rotate-180" : ""}`}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </button>
              {howOpen ? (
                <div id="profiles-howto" className="flex flex-col gap-4 border-t border-line-divider px-[22px] py-5">
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-2.5">
                    <HowWell title="What it does">
                      Add <span className="t-mono">?profile=&lt;id&gt;</span> to the connect URL. The gateway saves the login when the session
                      ends and loads it on the next connection with the same ID.
                    </HowWell>
                    <HowWell title="What gets saved">
                      Cookies and site storage on any provider. On browserserve a profile also keeps IndexedDB and service workers, the full
                      signed-in state that apps like Firebase or Supabase rely on.
                    </HowWell>
                    <HowWell title="Read-only mode">
                      Add <span className="t-mono">&amp;readOnly=1</span> to load a profile without locking it. Any number of sessions can use
                      it at once and nothing is written back.
                    </HowWell>
                    <HowWell title="One writer at a time">
                      Without read-only, one session uses a profile at a time so saved changes do not clash. A second session waits a few
                      seconds for the first to finish, then takes over.
                    </HowWell>
                    <HowWell title="Create and rename">
                      Use New profile, or connect with a new ID and it shows here after the first session ends. Renaming is not supported:
                      export, import under a new ID, then delete the old one.
                    </HowWell>
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className="t-label">Quick start by client</span>
                    <IntegrationTabs authEnabled={authEnabled} />
                  </div>
                </div>
              ) : null}
            </Card>
          ) : null}

          {data ? (
            <section aria-label="Turn off profiles" className="ui-card ui-card--danger flex flex-wrap items-center gap-4 px-[22px] py-5">
              <span className="flex min-w-0 flex-[1_1_300px] flex-col gap-0.5">
                <span className="t-h3">Turn off profiles</span>
                <span className="t-small">Saved profiles stay on disk. The gateway needs a restart.</span>
              </span>
              <Button variant="destructive-outline" onClick={() => setDisableOpen(true)} disabled={restartNotice !== null}>
                Turn off profiles
              </Button>
            </section>
          ) : null}
        </>
      )}

      <NewProfileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={dialogMode}
        authEnabled={authEnabled}
        onImport={handleImport}
        onCreated={(id) => {
          toast.success(`Created ${id}.`);
          void reload();
        }}
      />

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)} width={560} label="Delete profile">
        <DialogHeader
          title={deleting ? `Delete ${deleting.id}?` : "Delete profile"}
          description="The saved cookies and site storage are removed permanently. This cannot be undone."
          onClose={() => setDeleting(null)}
        />
        <DialogActions>
          <Button variant="outline" size="lg" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button variant="destructive" size="lg" onClick={() => void confirmDelete()} loading={deleteBusy}>
            Delete profile
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={disableOpen} onOpenChange={setDisableOpen} width={560} label="Turn off profiles">
        <DialogHeader
          title="Turn off profiles?"
          description="Profiles are turned off in gateway.yml. Existing profiles stay on disk. Restart the gateway for it to apply."
          onClose={() => setDisableOpen(false)}
        />
        <DialogActions>
          <Button variant="outline" size="lg" onClick={() => setDisableOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" size="lg" onClick={() => void confirmDisable()} loading={disableBusy}>
            Turn off profiles
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function HowWell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ui-well flex flex-col gap-1 px-4 py-3.5">
      <span className="text-sm font-bold">{title}</span>
      <span className="text-xs leading-relaxed text-fg-2">{children}</span>
    </div>
  );
}

function InfoCard({
  icon,
  title,
  children,
  href,
  quiet,
  gap = "gap-0.5",
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  href?: string;
  quiet?: boolean;
  gap?: string;
}) {
  const body = (
    <>
      <span
        className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full ${quiet ? "bg-track text-fg-2" : "bg-brand-soft text-brand-text"}`}
      >
        {icon}
      </span>
      <span className={`flex min-w-0 flex-col ${gap}`}>
        <span className="text-sm font-bold">{title}</span>
        {children}
      </span>
    </>
  );
  const cls = "ui-card flex items-start gap-3 rounded-row px-[18px] py-4 text-fg";
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

type CopyMode = "rw" | "ro";

const SMALL_BTN = "ui-btn ui-btn--sm";

function ProfileCard({
  profile: p,
  isDefault,
  connectUrl,
  onDelete,
}: {
  profile: ProfileMetaItem;
  isDefault: boolean;
  connectUrl: (readOnly: boolean) => string;
  onDelete: () => void;
}) {
  const [copyMode, setCopyMode] = useState<CopyMode>("rw");
  const param = `profile=${p.id}${copyMode === "ro" ? "&readOnly=1" : ""}`;
  const large = p.sizeBytes > LARGE_PROFILE_BYTES;
  return (
    <article className="ui-card flex flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 flex-none items-center justify-center rounded-input border border-line-strong bg-track text-[15px] font-bold text-brand-text">
          {p.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="t-mono truncate text-[17px] font-medium" title={p.id}>
              {p.id}
            </span>
            {isDefault ? <StatusBadge tone="accent">Default</StatusBadge> : null}
            {large ? (
              <span title="Above 5 MB. Above 50 MB the oldest sites are dropped when it saves.">
                <StatusBadge tone="warn">Large</StatusBadge>
              </span>
            ) : null}
          </span>
          <span className="text-xs text-fg-3" title={new Date(p.updatedAt).toLocaleString()}>
            Updated {formatWhen(p.updatedAt)}
          </span>
        </div>
        <RowMenu items={[{ label: "Delete", danger: true, onSelect: onDelete }]} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[
          [formatBytes(p.sizeBytes), "stored"],
          [formatWhen(p.updatedAt), "last saved"],
          [`v${p.dekVersion}`, "key version"],
        ].map(([value, label]) => (
          <div
            key={label}
            className="ui-well flex min-w-0 flex-col gap-px px-3 py-2.5"
            title={label === "key version" ? "Data encryption key version this profile was encrypted with" : undefined}
          >
            <span className="t-mono truncate text-[15px] font-medium">{value}</span>
            <span className="text-xs text-fg-3">{label}</span>
          </div>
        ))}
      </div>
      <div className="ui-well flex flex-wrap items-center gap-2 py-1.5 pl-3.5 pr-1.5">
        <span className="flex min-w-0 flex-[1_1_160px] items-center gap-1.5">
          <span className="t-mono min-w-0 flex-1 text-[12.5px] text-[var(--text-code)] [overflow-wrap:anywhere]">{param}</span>
          <CopyButton value={connectUrl(copyMode === "ro")} label="Copy connect URL" iconOnly />
        </span>
        <Segmented
          label="How the session uses it"
          value={copyMode}
          onChange={setCopyMode}
          options={[
            { value: "rw", label: "Read-write" },
            { value: "ro", label: "Read-only" },
          ]}
        />
      </div>
      <span className="-mt-1.5 text-xs text-fg-3">
        {copyMode === "rw"
          ? "Copy gives the full connect URL. Cookies and storage are written back when the session closes. One session at a time."
          : "Copy gives the full connect URL. Many sessions can share it at once and nothing is written back."}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <a href={exportProfileUrl(p.id, "bgp")} download className={SMALL_BTN} title={`Export ${p.id} as an encrypted .bgp file`}>
          Export .bgp
        </a>
        <a
          href={exportProfileUrl(p.id, "playwright")}
          download={`${p.id}.storagestate.json`}
          className={SMALL_BTN}
          title={`Export ${p.id} as a Playwright storageState JSON`}
        >
          Export for Playwright
        </a>
      </div>
    </article>
  );
}
