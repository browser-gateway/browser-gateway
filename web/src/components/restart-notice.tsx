import { Alert } from "@/components/ui/alert";

interface RestartNoticeProps {
  message: string;
}

export function RestartNotice({ message }: RestartNoticeProps) {
  return (
    <Alert variant="warn" title={message}>
      Restart the gateway for the change to apply.
    </Alert>
  );
}
