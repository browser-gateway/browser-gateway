import * as React from "react";
import { Button } from "@/components/ui/button";

interface SaveBarProps {
  dirty: boolean;
  saving?: boolean;
  status?: React.ReactNode;
  onDiscard: () => void;
  onSave: () => void;
  saveLabel?: string;
}

/** One bar pinned to the bottom of a page with several numeric settings. */
export function SaveBar({ dirty, saving, status, onDiscard, onSave, saveLabel = "Save changes" }: SaveBarProps) {
  return (
    <div className="ui-savebar" data-dirty={dirty}>
      <span className="min-w-0 flex-1 basis-[200px] text-[13px] text-fg-2">
        {status ?? (dirty ? "Unsaved changes." : "Everything is saved.")}
      </span>
      <Button variant="outline" onClick={onDiscard} disabled={!dirty || saving}>
        Discard
      </Button>
      <Button variant="primary" onClick={onSave} disabled={!dirty} loading={saving}>
        {saveLabel}
      </Button>
    </div>
  );
}
