import { describe, expect, it } from "vitest";
import {
  clamp,
  decayWeight,
  linearRegression,
  meanAbsoluteDeviation,
  median,
  mergeWindows,
  weightedMean,
  weightedQuantile,
} from "../src/freeloader.js";

describe("median and deviation", () => {
  it("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("measures spread around the median", () => {
    expect(meanAbsoluteDeviation([10, 10, 10])).toBe(0);
    expect(meanAbsoluteDeviation([8, 10, 12])).toBeCloseTo(4 / 3, 6);
    expect(meanAbsoluteDeviation([])).toBeNull();
  });
});

describe("weightedQuantile", () => {
  it("returns the only value when there is one sample", () => {
    expect(weightedQuantile([{ value: 42, weight: 1 }], 0.9)).toBe(42);
  });

  it("ignores zero-weight and non-finite samples", () => {
    const result = weightedQuantile(
      [
        { value: 1000, weight: 0 },
        { value: Number.NaN, weight: 5 },
        { value: 10, weight: 1 },
      ],
      0.9,
    );
    expect(result).toBe(10);
  });

  it("lets heavy samples pull the quantile toward them", () => {
    const light = weightedQuantile(
      [
        { value: 10, weight: 1 },
        { value: 100, weight: 1 },
      ],
      0.5,
    ) as number;
    const heavy = weightedQuantile(
      [
        { value: 10, weight: 1 },
        { value: 100, weight: 20 },
      ],
      0.5,
    ) as number;
    expect(heavy).toBeGreaterThan(light);
  });

  it("reaches the top of the distribution at q=1", () => {
    const samples = [5, 15, 25, 35].map((value) => ({ value, weight: 1 }));
    expect(weightedQuantile(samples, 1)).toBe(35);
    expect(weightedQuantile(samples, 0)).toBe(5);
  });

  it("returns null for an empty set", () => {
    expect(weightedQuantile([], 0.5)).toBeNull();
    expect(weightedMean([])).toBeNull();
  });
});

describe("linearRegression", () => {
  it("recovers a known slope and intercept", () => {
    // duration = 40ms overhead + 1ms per 1000 bytes -> 1 Mbyte/s.
    const points = [1000, 5000, 20_000, 80_000].map((x) => ({ x, y: 40 + x / 1000 }));
    const fit = linearRegression(points);
    expect(fit).not.toBeNull();
    expect((fit as { slope: number }).slope).toBeCloseTo(1 / 1000, 8);
    expect((fit as { intercept: number }).intercept).toBeCloseTo(40, 6);
    expect((fit as { r2: number }).r2).toBeCloseTo(1, 6);
  });

  it("refuses to fit fewer than three points or a single x value", () => {
    expect(linearRegression([{ x: 1, y: 2 }, { x: 2, y: 4 }])).toBeNull();
    expect(
      linearRegression([
        { x: 5, y: 1 },
        { x: 5, y: 2 },
        { x: 5, y: 3 },
      ]),
    ).toBeNull();
  });

  it("reports a low r2 for noise", () => {
    const points = [
      { x: 1, y: 9 },
      { x: 2, y: 1 },
      { x: 3, y: 8 },
      { x: 4, y: 2 },
      { x: 5, y: 7 },
    ];
    expect((linearRegression(points) as { r2: number }).r2).toBeLessThan(0.3);
  });
});

describe("decayWeight", () => {
  it("halves once per half-life", () => {
    expect(decayWeight(0, 1000)).toBe(1);
    expect(decayWeight(1000, 1000)).toBeCloseTo(0.5, 10);
    expect(decayWeight(3000, 1000)).toBeCloseTo(0.125, 10);
  });

  it("treats future timestamps as current", () => {
    expect(decayWeight(-5000, 1000)).toBe(1);
  });
});

describe("mergeWindows", () => {
  it("merges overlapping transfers and sums their bytes", () => {
    const merged = mergeWindows([
      { start: 0, end: 100, bytes: 100_000 },
      { start: 20, end: 120, bytes: 100_000 },
      { start: 50, end: 90, bytes: 50_000 },
    ]);
    expect(merged).toHaveLength(1);
    expect((merged[0] as { bytes: number }).bytes).toBe(250_000);
    expect((merged[0] as { start: number }).start).toBe(0);
    expect((merged[0] as { end: number }).end).toBe(120);
    expect((merged[0] as { count: number }).count).toBe(3);
  });

  it("recovers the true rate from parallel transfers", () => {
    // Six files, 500 KB each, all sharing one link for 1 second. Each looks
    // like 4 Mbps on its own; together they show the link is 24 Mbps.
    const windows = Array.from({ length: 6 }, () => ({ start: 0, end: 1000, bytes: 500_000 }));
    const merged = mergeWindows(windows);
    const burst = merged[0] as { bytes: number; end: number; start: number; concurrency: number };
    const bitsPerSecond = (burst.bytes * 8 * 1000) / (burst.end - burst.start);
    expect(bitsPerSecond).toBe(24_000_000);
    expect(burst.concurrency).toBeCloseTo(6, 5);
  });

  it("keeps separate bursts apart", () => {
    const merged = mergeWindows(
      [
        { start: 0, end: 100, bytes: 1000 },
        { start: 500, end: 600, bytes: 2000 },
      ],
      30,
    );
    expect(merged).toHaveLength(2);
  });

  it("bridges a gap smaller than the tolerance", () => {
    const merged = mergeWindows(
      [
        { start: 0, end: 100, bytes: 1000 },
        { start: 110, end: 200, bytes: 2000 },
      ],
      30,
    );
    expect(merged).toHaveLength(1);
  });

  it("tracks which bytes came over fresh connections", () => {
    const merged = mergeWindows([
      { start: 0, end: 100, bytes: 60_000, fresh: true },
      { start: 10, end: 90, bytes: 40_000, fresh: false },
    ]);
    expect((merged[0] as { freshBytes: number }).freshBytes).toBe(60_000);
  });

  it("drops degenerate windows", () => {
    expect(
      mergeWindows([
        { start: 10, end: 10, bytes: 500 },
        { start: 0, end: 5, bytes: 0 },
        { start: Number.NaN, end: 5, bytes: 100 },
      ]),
    ).toHaveLength(0);
  });
});

describe("clamp", () => {
  it("bounds on both sides", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
