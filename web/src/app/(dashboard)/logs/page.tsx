"use client";

import Link from "next/link";
import { FileText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";

export default function LogsPage() {
  return (
    <>
      <PageHeader title="Logs" description="Connection history, failover events and routing decisions from the gateway." />

      <EmptyState
        icon={FileText}
        title="Logs are in the terminal for now"
        hint="The gateway writes structured JSON logs to the terminal where it runs. A log viewer here is coming in a future update."
        action={
          <Link href="/sessions" className={buttonVariants({ variant: "outline" })}>
            See sessions
          </Link>
        }
      />

      <Card className="flex flex-col gap-3">
        <h2 className="t-h3">Where to find them</h2>
        <span className="t-small">Check the terminal where you started the gateway. Each line is one JSON event.</span>
        <pre className="ui-code">browser-gateway serve</pre>
        <span className="t-small">
          To keep them, send the output to a file, for example <span className="t-mono">browser-gateway serve &gt; gateway.log</span>.
        </span>
      </Card>
    </>
  );
}
