import type { SelectOption } from "@/components/ui/select";
import type { Strategy } from "@/lib/api";

export const STRATEGY_OPTIONS: SelectOption<Strategy>[] = [
  { value: "priority-chain", label: "Priority chain", hint: "Always use the highest-priority provider that has room." },
  { value: "round-robin", label: "Round robin", hint: "Spread sessions evenly across providers." },
  { value: "least-connections", label: "Least busy", hint: "Send to whichever provider has the fewest active sessions." },
  { value: "latency-optimized", label: "Fastest", hint: "Prefer the provider with the lowest recent latency." },
  { value: "weighted", label: "Weighted", hint: "Split traffic by each provider's weight." },
];
