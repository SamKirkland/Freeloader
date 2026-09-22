import { describe, expect, it } from "vitest";
import {
  BurstAggregator,
  burstToSample,
  parseTimingEntry,
  type TimingEntryLike,
} from "../src/freeloader.js";

function entry(overrides: Partial<TimingEntryLike> = {}): TimingEntryLike {
  return {
    name: "https://example.test/photo.jpg",
    entryType: "resource",
    initiatorType: "img",
    startTime: 100,
    duration: 220,
    transferSize: 500_000,
    encodedBodySize: 499_680,
    decodedBodySize: 499_680,
    domainLookupStart: 100,
    domainLookupEnd: 110,
    connectStart: 110,
    connectEnd: 150,
    requestStart: 150,
    responseStart: 170,
    responseEnd: 320,
    ...overrides,
  };
}

describe("parseTimingEntry", () => {
  it("reads a normal transfer", () => {
    const parsed = parseTimingEntry(entry());
    expect(parsed.skipped).toBeNull();
    expect(parsed.window).toEqual({ start: 170, end: 320, bytes: 500_000, fresh: true });
    expect(parsed.latency).toEqual({
      timeToFirstByteMilliseconds: 20,
      handshakeMilliseconds: 40,
      domainLookupMilliseconds: 10,
      source: "resource",
    });
  });

  it("skips a cache hit flagged by deliveryType", () => {
    const parsed = parseTimingEntry(entry({ deliveryType: "cache", transferSize: 0 }));
    expect(parsed.skipped).toBe("cache-hit");
    expect(parsed.window).toBeNull();
    expect(parsed.latency).toBeNull();
  });

  it("skips a response that never crossed the network", () => {
    expect(parseTimingEntry(entry({ transferSize: 0 })).skipped).toBe("no-transfer-size");
  });

  it("skips a cross-origin entry with no Timing-Allow-Origin", () => {
    const opaque = entry({ requestStart: 0, responseStart: 0, responseEnd: 0, transferSize: 4000 });
    expect(parseTimingEntry(opaque).skipped).toBe("opaque-timings");
  });

  it("keeps the latency reading but drops a transfer too short to time", () => {
    const parsed = parseTimingEntry(entry({ responseStart: 170, responseEnd: 170.5, transferSize: 900 }));
    expect(parsed.skipped).toBe("window-too-short");
    expect(parsed.window).toBeNull();
    expect(parsed.latency?.timeToFirstByteMilliseconds).toBe(20);
  });

  it("marks a reused connection as not fresh", () => {
    const reused = entry({ connectStart: 150, connectEnd: 150, domainLookupStart: 150, domainLookupEnd: 150 });
    const parsed = parseTimingEntry(reused);
    expect(parsed.window?.fresh).toBe(false);
    expect(parsed.latency?.handshakeMilliseconds).toBeNull();
    expect(parsed.latency?.domainLookupMilliseconds).toBeNull();
  });

  it("labels navigation entries", () => {
    expect(parseTimingEntry(entry({ entryType: "navigation" })).latency?.source).toBe("navigation");
  });
});

describe("BurstAggregator", () => {
  const options = { gapMilliseconds: 30, maximumPending: 100 };

  it("holds a burst open while more transfers could still join", () => {
    const aggregator = new BurstAggregator(options);
    aggregator.add({ start: 0, end: 100, bytes: 200_000 });
    expect(aggregator.closed(110)).toHaveLength(0); // Within the gap: still open.
    expect(aggregator.open(110)).toHaveLength(1);

    aggregator.add({ start: 105, end: 200, bytes: 300_000 });
    const ready = aggregator.closed(400);
    expect(ready).toHaveLength(1);
    expect((ready[0] as { bytes: number }).bytes).toBe(500_000);
  });

  it("re-merges a burst when an overlapping transfer is reported late", () => {
    const aggregator = new BurstAggregator(options);
    // A short image finishes first and looks like a lone 100 KB transfer.
    aggregator.add({ start: 0, end: 500, bytes: 100_000 });
    const early = aggregator.closed(1000);
    expect(early).toHaveLength(1);
    expect((early[0] as { concurrency: number }).concurrency).toBeCloseTo(1, 5);

    // The big image it was sharing the link with only reports now.
    aggregator.add({ start: 0, end: 4000, bytes: 900_000 });
    const revised = aggregator.closed(5000);
    expect(revised).toHaveLength(1);
    expect((revised[0] as { bytes: number }).bytes).toBe(1_000_000);
    expect((revised[0] as { count: number }).count).toBe(2);
  });

  it("keeps separate bursts apart", () => {
    const aggregator = new BurstAggregator(options);
    aggregator.add({ start: 0, end: 100, bytes: 100_000 });
    aggregator.add({ start: 900, end: 1000, bytes: 100_000 });
    expect(aggregator.closed(1010)).toHaveLength(1);
    expect(aggregator.open(1010)).toHaveLength(1);
  });

  it("settles bursts past the horizon and forgets their windows", () => {
    const aggregator = new BurstAggregator(options);
    aggregator.add({ start: 0, end: 100, bytes: 100_000 });
    aggregator.add({ start: 9000, end: 9100, bytes: 100_000 });

    const settled = aggregator.prune(5000);
    expect(settled).toHaveLength(1);
    expect((settled[0] as { end: number }).end).toBe(100);
    expect(aggregator.pendingCount).toBe(1); // Only the recent burst is still revisable.
  });

  it("hands everything back when cleared", () => {
    const aggregator = new BurstAggregator(options);
    aggregator.add({ start: 0, end: 100, bytes: 100_000 });
    aggregator.add({ start: 9000, end: 9100, bytes: 100_000 });
    expect(aggregator.clear()).toHaveLength(2);
    expect(aggregator.pendingCount).toBe(0);
  });

  it("bounds its buffer", () => {
    const aggregator = new BurstAggregator({ gapMilliseconds: 30, maximumPending: 10 });
    for (let i = 0; i < 50; i++) {
      aggregator.add({ start: i * 1000, end: i * 1000 + 10, bytes: 1000 });
    }
    expect(aggregator.pendingCount).toBeLessThanOrEqual(10);
  });
});

describe("burstToSample", () => {
  it("converts bytes over a window into bits per second", () => {
    const sample = burstToSample(
      { start: 0, end: 1000, bytes: 1_250_000, count: 1, concurrency: 1, freshBytes: 1_250_000, members: [] },
      1_700_000_000_000,
    );
    expect(sample?.bitsPerSecond).toBe(10_000_000);
    expect(sample?.freshFraction).toBe(1);
    expect(sample?.at).toBe(1_700_000_001_000);
    expect(sample?.source).toBe("resource");
  });

  it("labels multi-transfer bursts and records the fresh share", () => {
    const sample = burstToSample(
      { start: 0, end: 500, bytes: 200_000, count: 4, concurrency: 3.2, freshBytes: 50_000, members: [] },
      0,
    );
    expect(sample?.source).toBe("burst");
    expect(sample?.freshFraction).toBe(0.25);
  });

  it("rejects windows that are too short or empty", () => {
    const base = { start: 0, end: 1, count: 1, concurrency: 1, freshBytes: 0, members: [] };
    expect(burstToSample({ ...base, bytes: 1000 }, 0)).toBeNull();
    expect(burstToSample({ ...base, end: 1000, bytes: 0 }, 0)).toBeNull();
  });
});
