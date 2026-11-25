"use client";

import * as React from "react";
import { Dialog, DialogActions, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string | null;
  onConfirm: () => Promise<void>;
}

export function ProviderDeleteDialog({ open, onOpenChange, providerId, onConfirm }: Props) {
  const [busy, setBusy] = React.useState(false);

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={560} label="Remove provider">
      <DialogHeader
        title={
          <>
            Remove <span className="t-mono">{providerId}</span>?
          </>
        }
        onClose={() => onOpenChange(false)}
      />
      <DialogBody>
        New sessions stop going to this provider. Sessions open on it right now stay connected until the client disconnects.
      </DialogBody>
      <DialogActions>
        <Button variant="outline" size="lg" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" size="lg" onClick={() => void handleConfirm()} loading={busy}>
          Remove provider
        </Button>
      </DialogActions>
    </Dialog>
  );
}
