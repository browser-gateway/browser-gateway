"use client";

import { useState } from "react";
import { Check, Loader2, Settings2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { setProfileProxy } from "@/lib/api";
import { ProfileProxyField } from "./profile-proxy-field";

/** Edit drawer for a profile's settings. */
export function ProfileSettingsSheet({ id, proxy, disabled, onSaved }: { id: string; proxy: string | null; disabled?: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string | null>(proxy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await setProfileProxy(id, value);
      onSaved();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setValue(proxy);
          setError(null);
        }
        setOpen(next);
      }}
    >
      <SheetTrigger
        render={
          <Button variant="outline" size="sm" disabled={disabled} title={`Edit ${id}`}>
            <Settings2 className="size-3.5" />
          </Button>
        }
      />
      <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
        <SheetHeader className="pr-12">
          <SheetTitle>Edit {id}</SheetTitle>
          <SheetDescription>Settings for sessions that use this profile.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <ProfileProxyField value={value} onChange={setValue} />
          {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
        </div>
        <SheetFooter className="flex-row justify-end gap-2 border-t border-border">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={saving || value === proxy} onClick={save}>
            {saving ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Check className="size-3.5 mr-1.5" />}
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
