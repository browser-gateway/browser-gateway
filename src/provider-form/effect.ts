import type { SiblingProvider } from "./types.js";

export interface PriorityEffect {
  rank: number;
  label: string;
  tiedCount: number;
}

export interface WeightEffect {
  percent: number;
  label: string;
  isOnlyAtTier: boolean;
}

/**
 * Describes a provider's routing position given its priority and every sibling's
 * priority (including its own). Rank 0 = primary, 1 = first fallback, and so on.
 * Ties at the same priority are grouped and share traffic via the router strategy.
 */
export function computePriorityEffect(
  priority: number,
  siblingPriorities: number[],
): PriorityEffect {
  const uniqueTiers = Array.from(new Set(siblingPriorities)).sort((a, b) => a - b);
  const rank = uniqueTiers.indexOf(priority);
  const tiedCount = siblingPriorities.filter((p) => p === priority).length;

  if (rank === -1) {
    return {
      rank: 0,
      label: "Primary. Tried first.",
      tiedCount: 1,
    };
  }

  const siblingLabel =
    tiedCount > 1
      ? ` Shares traffic with ${tiedCount - 1} other ${tiedCount - 1 === 1 ? "provider" : "providers"} at this priority.`
      : "";

  if (rank === 0) {
    return {
      rank,
      label: `Primary. Tried first.${siblingLabel}`,
      tiedCount,
    };
  }

  const ordinal = rank === 1 ? "" : ` #${rank}`;
  return {
    rank,
    label: `Fallback${ordinal}. Used when higher-priority providers are full or down.${siblingLabel}`,
    tiedCount,
  };
}

/**
 * Describes a provider's share of traffic among siblings at the same priority.
 * Returns 100% and an "only at this tier" label when nothing else shares the tier.
 */
export function computeWeightEffect(
  priority: number,
  weight: number,
  siblings: SiblingProvider[],
): WeightEffect {
  const atTier = siblings.filter((s) => s.priority === priority);
  const totalWeight = atTier.reduce((sum, s) => sum + Math.max(1, s.weight), 0);
  const own = Math.max(1, weight);

  if (atTier.length <= 1 || totalWeight === 0) {
    return {
      percent: 100,
      label: "Only provider at this priority. Receives 100% of traffic when reached.",
      isOnlyAtTier: true,
    };
  }

  const percent = Math.round((own / totalWeight) * 100);
  const otherCount = atTier.length - 1;
  return {
    percent,
    label: `Receives ~${percent}% of traffic at this priority (${own} of ${totalWeight} across ${otherCount + 1} providers).`,
    isOnlyAtTier: false,
  };
}
