import { describe, expect, it } from "vitest";
import { Freeloader, parseTimingEntry, type TimingEntryLike } from "../src/freeloader.js";

/**
 * A cache hit is the most dangerous entry a passive measurement can see.
 *
 * The numbers below are not invented: they are what Chrome actually reported
 * for a 1.5 MB JPEG served from its cache, captured from a real page. Taken at
 * face value the entry says 1,526,026 bytes arrived in 0.9 ms, which is 13.6
 * Gbps on a link that had not moved a byte. Everything here exists to make sure
 * that entry never reaches the estimator.
 */

/** Exactly what Chrome reports for a memory-cache hit. */
function cacheHit(overrides: Partial<TimingEntryLike> = {}): TimingEntryLike {
  return {
    name: "https://example.test/gallery-03.jpg",
    entryType: "resource",
    initiatorType: "img",
    startTime: 1000,
    duration: 0.9,
    // The body is real and large; not one byte of it crossed the network.
    transferSize: 0,
    encodedBodySize: 1_526_026,
    decodedBodySize: 1_526_026,
    deliveryType: "cache",
    requestStart: 1000,
    responseStart: 1000.1,
    responseEnd: 1000.9,
    ...overrides,
  };
}

/** The same file actually fetched, at a believable rate. */
function realTransfer(startTime: number): TimingEntryLike {
  return {
    name: `https://example.test/gallery-03.jpg?v=${startTime}`,
    entryType: "resource",
    initiatorType: "img",
    startTime,
    duration: 500,
    transferSize: 1_526_326,
    encodedBodySize: 1_526_026,
    decodedBodySize: 1_526_026,
    requestStart: startTime,
    responseStart: startTime + 20,
    responseEnd: startTime + 500,
  };
}

describe("a cache hit", () => {
  it("is skipped on the deliveryType Chrome sets", () => {
    const parsed = parseTimingEntry(cacheHit());
    expect(parsed.skipped).toBe("cache-hit");
    expect(parsed.window).toBeNull();
  });

  it("is still skipped on an older browser that sets no deliveryType", () => {
    // Before deliveryType existed, a zero transferSize was the only signal —
    // and it is the same signal a cross-origin response without
    // Timing-Allow-Origin gives, which must also be skipped.
    const parsed = parseTimingEntry(cacheHit({ deliveryType: undefined }));
    expect(parsed.skipped).toBe("no-transfer-size");
    expect(parsed.window).toBeNull();
  });

  it("does not move an estimate built from real transfers", () => {
    const freeloader = new Freeloader(
      { persist: false, instrumentUploads: false, now: () => 2_000_000, timeOrigin: 0 },
      null,
    );

    // A cold visit: four real transfers, spaced so they do not merge.
    for (let i = 0; i < 4; i++) freeloader.ingest(realTransfer(1000 + i * 2000));
    freeloader.flush(200_000);

    const cold = freeloader.getEstimate().download;
    const coldBytes = freeloader.debug().totals.downloadBytes;
    expect(cold.bitsPerSecond).not.toBeNull();

    // A warm visit: the same page, every asset out of the cache.
    for (let i = 0; i < 12; i++) freeloader.ingest(cacheHit({ startTime: 300_000 + i * 10 }));
    freeloader.flush(400_000);

    const warm = freeloader.getEstimate().download;
    expect(warm.bitsPerSecond).toBe(cold.bitsPerSecond);
    expect(warm.peakBitsPerSecond).toBe(cold.peakBitsPerSecond);
    expect(warm.averageBitsPerSecond).toBe(cold.averageBitsPerSecond);
    expect(freeloader.debug().totals.downloadBytes).toBe(coldBytes);
    expect(freeloader.debug().skipped["cache-hit"]).toBe(12);
  });

  it("cannot produce an estimate on its own", () => {
    const freeloader = new Freeloader(
      { persist: false, instrumentUploads: false, now: () => 2_000_000, timeOrigin: 0 },
      null,
    );
    for (let i = 0; i < 20; i++) freeloader.ingest(cacheHit({ startTime: 1000 + i * 10 }));
    freeloader.flush(200_000);

    // Twenty cached megabytes say nothing about the link, and the library
    // reports nothing rather than 13 Gbps.
    expect(freeloader.getEstimate().download.bitsPerSecond).toBeNull();
    expect(freeloader.debug().totals.downloadBytes).toBe(0);
  });
});

describe("a 304 revalidation", () => {
  /** Headers cross the network; the body comes from the cache. */
  function notModified(startTime: number): TimingEntryLike {
    return {
      name: `https://example.test/site.css?v=${startTime}`,
      entryType: "resource",
      initiatorType: "link",
      startTime,
      duration: 22,
      // Only the response headers were transferred.
      transferSize: 310,
      encodedBodySize: 0,
      decodedBodySize: 120_000,
      requestStart: startTime,
      responseStart: startTime + 20,
      responseEnd: startTime + 22,
    };
  }

  it("reports low confidence rather than a slow link", () => {
    const freeloader = new Freeloader(
      { persist: false, instrumentUploads: false, now: () => 2_000_000, timeOrigin: 0 },
      null,
    );
    for (let i = 0; i < 10; i++) freeloader.ingest(notModified(1000 + i * 3000));
    freeloader.flush(200_000);

    const estimate = freeloader.getEstimate();
    // 310 bytes in 2 ms reads as 1.2 Mbps, and ten of them agree with each
    // other perfectly — numerous, consistent, and worthless, since they total
    // three kilobytes. The figure stands as a floor, with confidence to match.
    expect(estimate.download.confidence.bytes).toBeLessThan(5000);
    expect(estimate.download.confidence.score).toBeLessThan(0.15);
  });
});
