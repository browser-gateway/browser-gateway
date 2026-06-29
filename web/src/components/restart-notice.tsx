import { Info } from "lucide-react";

interface RestartNoticeProps {
  message: string;
}

export function RestartNotice({ message }: RestartNoticeProps) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-4 text-sm">
      <Info className="size-4 shrink-0 text-muted-foreground mt-0.5" />
      <div>
        <p className="font-medium">{message}</p>
        <p className="mt-1 text-muted-foreground text-[13px]">
          Restart the gateway for the change to apply.
        </p>
      </div>
    </div>
  );
}
