import type { SelectOption } from "@/components/ui/select";
import type { ProxySummary } from "@/lib/api";

/** Every saved proxy as a picker option; ones that cannot be used are shown disabled with the reason. */
export function proxyPickerOptions(proxies: ProxySummary[]): SelectOption[] {
  return proxies.map((p) => ({
    value: p.name,
    label: p.name,
    disabled: !p.usable,
    hint: !p.usable
      ? `Cannot be used: ${p.reason ?? "invalid address"}`
      : p.server ?? undefined,
  }));
}
