import { describe, it, expect } from "vitest";
import {
  computePriorityEffect,
  computeWeightEffect,
  slugifyProviderName,
  isValidProviderUrl,
  validateProviderSlug,
  validateProviderUrl,
  validatePositiveInteger,
  validateHeaderRows,
  headersToRecord,
  recordToHeaderRows,
  HEADER_LIMITS,
  type HeaderRow,
} from "../../src/provider-form/index.js";

describe("computePriorityEffect", () => {
  it("labels the lowest priority as primary when alone", () => {
    const e = computePriorityEffect(1, [1]);
    expect(e.rank).toBe(0);
    expect(e.tiedCount).toBe(1);
    expect(e.label).toContain("Primary");
    expect(e.label).not.toContain("Shares traffic");
  });

  it("labels a strictly lower priority as primary among many", () => {
    const e = computePriorityEffect(1, [1, 5, 10]);
    expect(e.rank).toBe(0);
    expect(e.label).toContain("Primary. Tried first.");
    expect(e.label).not.toContain("Shares traffic");
  });

  it("labels a fallback with correct rank", () => {
    const e = computePriorityEffect(5, [1, 5, 10]);
    expect(e.rank).toBe(1);
    expect(e.label).toContain("Fallback");
    expect(e.label).not.toContain("#");
  });

  it("numbers deeper fallbacks", () => {
    const e = computePriorityEffect(10, [1, 5, 10, 20]);
    expect(e.rank).toBe(2);
    expect(e.label).toContain("Fallback #2");
  });

  it("notes ties at the same priority", () => {
    const e = computePriorityEffect(1, [1, 1, 1, 5]);
    expect(e.tiedCount).toBe(3);
    expect(e.label).toContain("Shares traffic with 2 other providers");
  });

  it("uses singular provider when only one sibling ties", () => {
    const e = computePriorityEffect(1, [1, 1, 5]);
    expect(e.label).toContain("Shares traffic with 1 other provider");
    expect(e.label).not.toContain("providers");
  });

  it("handles a priority outside the sibling list gracefully", () => {
    const e = computePriorityEffect(50, [1, 5]);
    expect(e.label).toBe("Primary. Tried first.");
  });
});

describe("computeWeightEffect", () => {
  it("reports 100% when alone at a priority", () => {
    const e = computeWeightEffect(1, 100, [{ slug: "a", priority: 1, weight: 100 }]);
    expect(e.percent).toBe(100);
    expect(e.isOnlyAtTier).toBe(true);
  });

  it("splits traffic proportionally among siblings at the same priority", () => {
    const siblings = [
      { slug: "a", priority: 1, weight: 3 },
      { slug: "b", priority: 1, weight: 7 },
    ];
    const eA = computeWeightEffect(1, 3, siblings);
    expect(eA.percent).toBe(30);
    expect(eA.isOnlyAtTier).toBe(false);
    expect(eA.label).toContain("~30%");
    const eB = computeWeightEffect(1, 7, siblings);
    expect(eB.percent).toBe(70);
  });

  it("ignores siblings at a different priority", () => {
    const e = computeWeightEffect(1, 5, [
      { slug: "a", priority: 1, weight: 5 },
      { slug: "b", priority: 10, weight: 100 },
    ]);
    expect(e.percent).toBe(100);
    expect(e.isOnlyAtTier).toBe(true);
  });

  it("treats zero-weight as one to avoid divide-by-zero", () => {
    const e = computeWeightEffect(1, 0, [
      { slug: "a", priority: 1, weight: 0 },
      { slug: "b", priority: 1, weight: 0 },
    ]);
    expect(e.percent).toBe(50);
  });
});

describe("slugifyProviderName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyProviderName("My Playwright Cloud")).toBe("my-playwright-cloud");
  });
  it("strips leading and trailing hyphens", () => {
    expect(slugifyProviderName("--foo--")).toBe("foo");
  });
  it("caps at max length", () => {
    const long = "a".repeat(100);
    expect(slugifyProviderName(long).length).toBe(64);
  });
});

describe("isValidProviderUrl", () => {
  it.each([
    ["ws://x", true],
    ["wss://x", true],
    ["http://x", true],
    ["https://x", true],
    ["ftp://x", false],
    ["x", false],
    ["", false],
  ])("%s -> %s", (input, expected) => {
    expect(isValidProviderUrl(input)).toBe(expected);
  });
});

describe("validateProviderSlug", () => {
  it("rejects empty", () => {
    expect(validateProviderSlug("")).toMatch(/name/i);
  });
  it("rejects uppercase or spaces", () => {
    expect(validateProviderSlug("Foo Bar")).toMatch(/lowercase/i);
  });
  it("accepts valid", () => {
    expect(validateProviderSlug("valid-slug-1")).toBeNull();
  });
});

describe("validateProviderUrl", () => {
  it("rejects empty", () => {
    expect(validateProviderUrl("")).toMatch(/enter/i);
  });
  it("rejects wrong scheme", () => {
    expect(validateProviderUrl("ftp://x")).toMatch(/ws|http/);
  });
  it("accepts valid wss", () => {
    expect(validateProviderUrl("wss://x.com")).toBeNull();
  });
});

describe("validatePositiveInteger", () => {
  it("allows empty", () => {
    expect(validatePositiveInteger("", "X")).toBeNull();
  });
  it("rejects zero", () => {
    expect(validatePositiveInteger("0", "X")).toMatch(/at least 1/i);
  });
  it("rejects negative", () => {
    expect(validatePositiveInteger("-1", "X")).toMatch(/at least 1/i);
  });
  it("rejects fractional", () => {
    expect(validatePositiveInteger("1.5", "X")).toMatch(/whole/i);
  });
  it("accepts positive integer", () => {
    expect(validatePositiveInteger("100", "X")).toBeNull();
  });
});

describe("validateHeaderRows", () => {
  const row = (k: string, v: string): HeaderRow => ({ id: `${k}-${v}`, key: k, value: v });

  it("accepts empty rows", () => {
    expect(validateHeaderRows([])).toBeNull();
  });
  it("accepts rows that are all blank (user just added, not filled)", () => {
    expect(validateHeaderRows([row("", "")])).toBeNull();
  });
  it("rejects a row with only a key", () => {
    expect(validateHeaderRows([row("X", "")])).toMatch(/both a name and a value/i);
  });
  it("rejects a row with only a value", () => {
    expect(validateHeaderRows([row("", "v")])).toMatch(/both a name and a value/i);
  });
  it("rejects too many headers", () => {
    const rows = Array.from({ length: HEADER_LIMITS.maxHeaders + 1 }, (_, i) =>
      row(`k${i}`, "v"),
    );
    expect(validateHeaderRows(rows)).toMatch(/Up to/i);
  });
  it("rejects an over-long key", () => {
    expect(validateHeaderRows([row("x".repeat(HEADER_LIMITS.keyMaxLength + 1), "v")]))
      .toMatch(/Header names/i);
  });
  it("rejects an over-long value", () => {
    expect(validateHeaderRows([row("K", "x".repeat(HEADER_LIMITS.valueMaxLength + 1))]))
      .toMatch(/Header values/i);
  });
});

describe("headersToRecord / recordToHeaderRows", () => {
  it("round-trips", () => {
    const rec = { Authorization: "Bearer x", "X-Custom": "y" };
    const rows = recordToHeaderRows(rec);
    expect(rows).toHaveLength(2);
    const back = headersToRecord(rows);
    expect(back).toEqual(rec);
  });
  it("returns undefined for empty rows", () => {
    expect(headersToRecord([])).toBeUndefined();
  });
  it("drops blank keys or blank values", () => {
    const rows: HeaderRow[] = [
      { id: "1", key: "K", value: "V" },
      { id: "2", key: "", value: "V2" },
      { id: "3", key: "K3", value: "" },
    ];
    expect(headersToRecord(rows)).toEqual({ K: "V" });
  });
  it("returns empty array for null/undefined record", () => {
    expect(recordToHeaderRows(null)).toEqual([]);
    expect(recordToHeaderRows(undefined)).toEqual([]);
  });
});
