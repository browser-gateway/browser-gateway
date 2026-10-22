"use client";

import { useEffect, useState } from "react";
import { Select, type SelectOption } from "@/components/ui/select";
import { fetchProxies } from "@/lib/api";
import { proxyPickerOptions } from "@/lib/proxy-options";

const NONE = "";

/** Picker for the proxy a profile keeps, with the help text that explains it. */
export function ProfileProxyField({ value, onChange }: { value: string | null; onChange: (proxy: string | null) => void }) {
  const [options, setOptions] = useState<SelectOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProxies()
      .then(({ proxies }) => !cancelled && setOptions([{ value: NONE, label: "None" }, ...proxyPickerOptions(proxies)]))
      .catch(() => !cancelled && setOptions([{ value: NONE, label: "None" }]));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-1.5">
      <span className="text-[12px] font-medium text-foreground/80">Proxy for this profile</span>
      <Select
        label="Proxy"
        value={value ?? NONE}
        options={options ?? [{ value: NONE, label: "None" }]}
        onChange={(v) => onChange(v === NONE ? null : v)}
        disabled={options === null}
        width="min-w-[14rem]"
      />
      <p className="text-[11px] text-muted-foreground">
        Sessions that use this profile go through this proxy unless the connection names another one or proxy=none.
        Keeps a saved login on the same internet address, for example a Google login made through your home proxy.
      </p>
    </div>
  );
}
