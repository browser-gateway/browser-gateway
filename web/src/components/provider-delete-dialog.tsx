"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove provider</DialogTitle>
          <DialogDescription>
            Removes <span className="font-mono">{providerId}</span> from routing. Any active
            sessions on this provider stay connected until the client disconnects.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            Remove provider
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
