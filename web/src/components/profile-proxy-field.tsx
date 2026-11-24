"use client";

import { useEffect, useState } from "react";
import { Field } from "@/components/ui/field";
import { Select, type SelectOption } from "@/components/ui/select";
import { fetchProxies } from "@/lib/api";
import { proxyPickerOptions } from "@/lib/proxy-options";

const NONE = "";
const NONE_OPTION: SelectOption = { value: NONE, label: "None" };

export function ProfileProxyField({ value, onChange }: { value: string | null; onChange: (proxy: string | null) => void }) {
  const [options, setOptions] = useState<SelectOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProxies()
      .then(({ proxies }) => !cancelled && setOptions([NONE_OPTION, ...proxyPickerOptions(proxies)]))
      .catch(() => !cancelled && setOptions([NONE_OPTION]));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Field
      id="profile-proxy"
      label="Proxy for this profile"
      optional
      help="Sessions that use this profile go through this proxy unless the connection names another one or proxy=none. Example: keep a Google login on your home proxy so it always comes back from the same address."
    >
      <Select
        id="profile-proxy"
        label="Proxy"
        hideLabel
        fullWidth
        value={value ?? NONE}
        options={options ?? [NONE_OPTION]}
        onChange={(v) => onChange(v === NONE ? null : v)}
        disabled={options === null}
        footer={{ label: "Manage proxies", href: "/proxies/" }}
      />
    </Field>
  );
}
