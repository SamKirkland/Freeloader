import { describe, expect, it } from "vitest";
import {
  correctSlowStart,
  estimateDirection,
  estimateLatency,
  type EstimatorConfig,
  type LatencySample,
  type ThroughputSample,
} from "../src/freeloader.js";

const NOW = 1_700_000_000_000;

const CONFIG: EstimatorConfig = {
  minimumSampleBytes: 32 * 1024,
  quantile: 0.9,
  halfLifeMilliseconds: 24 * 60 * 60 * 1000,
  roundTripMilliseconds: null,
};

function sample(overrides: Partial<ThroughputSample> = {}): ThroughputSample {
  const bytes = overrides.bytes ?? 1_000_000;
  const durationMilliseconds = overrides.durationMilliseconds ?? 800;
  return {
    bytes,
    durationMilliseconds,
    bitsPerSecond: (bytes * 8 * 1000) / durationMilliseconds,
    concurrency: 1,
    resources: 1,
    freshFraction: 0,
    at: NOW,
    source: "burst",
    ...overrides,
  };
}

describe("estimateDirection", () => {
  it("returns nothing when there are no samples", () => {
    const estimate = estimateDirection([], CONFIG, NOW);
    expect(estimate.bitsPerSecond).toBeNull();
    expect(estimate.confidence.score).toBe(0);
    expect(estimate.resources).toBe(0);
  });

  it("counts the resources in the samples it used, not the ones below the size gate", () => {
    const samples = [
      sample({ resources: 6 }),
      sample({ resources: 1 }),
      sample({ bytes: 2_000, durationMilliseconds: 20, resources: 3 }),
    ];
    expect(estimateDirection(samples, CONFIG, NOW).resources).toBe(7);
  });

  it("recovers the rate from a set of consistent samples", () => {
    const samples = Array.from({ length: 6 }, () => sample({ bytes: 1_250_000, durationMilliseconds: 1000 }));
    const estimate = estimateDirection(samples, CONFIG, NOW);
    expect(estimate.bitsPerSecond).toBeCloseTo(10_000_000, 0);
    expect(estimate.megabitsPerSecond).toBeCloseTo(10, 6);
  });

  it("reaches for the top of the distribution, because slow samples are the biased ones", () => {
    // One clean run at 50 Mbps, several throttled by the page doing other work.
    const samples = [
      sample({ bytes: 5_000_000, durationMilliseconds: 800 }), // 50 Mbps
      sample({ bytes: 1_000_000, durationMilliseconds: 800 }), // 10 Mbps
      sample({ bytes: 1_000_000, durationMilliseconds: 1000 }), // 8 Mbps
      sample({ bytes: 1_000_000, durationMilliseconds: 1200 }), // 6.7 Mbps
    ];
    const estimate = estimateDirection(samples, CONFIG, NOW);
    expect(estimate.bitsPerSecond as number).toBeGreaterThan(20e6);
    expect(estimate.peakBitsPerSecond).toBeCloseTo(50e6, 0);
  });

  it("weights recent samples above stale ones", () => {
    const hour = 60 * 60 * 1000;
    const samples = [
      sample({ bytes: 5_000_000, durationMilliseconds: 400, at: NOW - 72 * hour }), // Old and fast.
      ...Array.from({ length: 5 }, () => sample({ bytes: 1_000_000, durationMilliseconds: 800, at: NOW })),
    ];
    const estimate = estimateDirection(samples, CONFIG, NOW);
    expect(estimate.bitsPerSecond as number).toBeLessThan(20e6);
  });

  it("discounts confidence when every sample is below the size gate", () => {
    const tiny = Array.from({ length: 5 }, () => sample({ bytes: 9_000, durationMilliseconds: 20 }));
    const big = Array.from({ length: 5 }, () => sample({ bytes: 900_000, durationMilliseconds: 2000 }));
    const tinyScore = estimateDirection(tiny, CONFIG, NOW).confidence.score;
    const bigScore = estimateDirection(big, CONFIG, NOW).confidence.score;
    expect(tinyScore).toBeLessThan(bigScore);
    expect(tinyScore).toBeLessThan(0.5);
  });

  it("reports a wide spread when samples disagree", () => {
    const messy = [
      sample({ bytes: 1_000_000, durationMilliseconds: 200 }),
      sample({ bytes: 1_000_000, durationMilliseconds: 2000 }),
      sample({ bytes: 1_000_000, durationMilliseconds: 600 }),
      sample({ bytes: 1_000_000, durationMilliseconds: 4000 }),
    ];
    const tidy = Array.from({ length: 4 }, () => sample({ bytes: 1_000_000, durationMilliseconds: 800 }));
    expect(estimateDirection(messy, CONFIG, NOW).confidence.spread).toBeGreaterThan(
      estimateDirection(tidy, CONFIG, NOW).confidence.spread,
    );
  });

  it("uses a regression over varied sizes to strip per-request overhead", () => {
    // A 30 ms fixed overhead on every request, plus 1 ms per 12.5 KB (100 Mbps).
    const sizes = [50_000, 120_000, 300_000, 900_000, 2_400_000, 5_000_000];
    const samples = sizes.map((bytes) =>
      sample({ bytes, durationMilliseconds: 30 + bytes / 12_500, concurrency: 1 }),
    );
    const estimate = estimateDirection(samples, CONFIG, NOW);
    expect(estimate.regressionBitsPerSecond).not.toBeNull();
    expect(estimate.regressionBitsPerSecond as number).toBeCloseTo(100e6, -6);
    // A 5 MB transfer is in this set, and a transfer that large is the firmest
    // evidence there is, so it caps the reported figure even though the fit
    // knows the link is a little quicker than any single sample showed.
    expect(estimate.bitsPerSecond as number).toBeCloseTo(estimate.peakBitsPerSecond as number, 0);
  });

  it("lets the regression raise the estimate when every transfer was small", () => {
    // 40 ms of overhead on each request, then 1 ms per 12.5 KB (100 Mbps).
    // Nothing here is big enough to cap against, so the fit carries the day.
    const sizes = [40_000, 60_000, 90_000, 140_000, 200_000, 250_000];
    const samples = sizes.map((bytes) =>
      sample({ bytes, durationMilliseconds: 40 + bytes / 12_500, concurrency: 1 }),
    );
    const estimate = estimateDirection(samples, CONFIG, NOW);
    expect(estimate.bitsPerSecond as number).toBeGreaterThan(estimate.peakBitsPerSecond as number);
    expect(estimate.regressionBitsPerSecond as number).toBeCloseTo(100e6, -6);
  });

  it("ignores the regression when parallel transfers make it meaningless", () => {
    const sizes = [50_000, 120_000, 300_000, 900_000, 2_400_000, 5_000_000];
    const samples = sizes.map((bytes) =>
      sample({ bytes, durationMilliseconds: 30 + bytes / 12_500, concurrency: 5 }),
    );
    expect(estimateDirection(samples, CONFIG, NOW).regressionBitsPerSecond).toBeNull();
  });

  it("falls back to sub-gate samples rather than reporting nothing", () => {
    const tiny = Array.from({ length: 3 }, () => sample({ bytes: 8_000, durationMilliseconds: 10 }));
    expect(estimateDirection(tiny, CONFIG, NOW).bitsPerSecond).not.toBeNull();
  });
});

describe("correctSlowStart", () => {
  it("does nothing without a round-trip estimate", () => {
    expect(correctSlowStart(5_000_000, 400, 1, null)).toBe(400);
    expect(correctSlowStart(5_000_000, 400, 1, 0)).toBe(400);
  });

  it("does nothing for a transfer that never left the initial window", () => {
    // 10 KB in 50 ms on a 20 ms link: one window, no ramp to remove.
    expect(correctSlowStart(10_000, 50, 1, 20)).toBe(50);
  });

  it("shortens a transfer that spent time ramping", () => {
    const corrected = correctSlowStart(5_000_000, 400, 1, 20);
    expect(corrected).toBeLessThan(400);
    expect(corrected).toBeGreaterThan(200); // Capped at half the duration.
  });

  it("never removes more than half the duration", () => {
    expect(correctSlowStart(50_000_000, 100, 1, 200)).toBeGreaterThanOrEqual(50);
  });

  it("corrects less when several connections ramp together", () => {
    const solo = correctSlowStart(5_000_000, 400, 1, 20);
    const parallel = correctSlowStart(5_000_000, 400, 6, 20);
    expect(parallel).toBeGreaterThan(solo);
  });

  it("scales with the requested strength", () => {
    const full = correctSlowStart(5_000_000, 400, 1, 20, 1);
    const half = correctSlowStart(5_000_000, 400, 1, 20, 0.5);
    expect(half).toBeGreaterThan(full);
    expect(correctSlowStart(5_000_000, 400, 1, 20, 0)).toBe(400);
  });

  it("is applied to fresh-connection samples only", () => {
    const cold = sample({ bytes: 5_000_000, durationMilliseconds: 400, freshFraction: 1 });
    const warm = sample({ bytes: 5_000_000, durationMilliseconds: 400, freshFraction: 0 });
    const config = { ...CONFIG, roundTripMilliseconds: 20 };
    const coldEstimate = estimateDirection([cold, cold, cold], config, NOW).bitsPerSecond as number;
    const warmEstimate = estimateDirection([warm, warm, warm], config, NOW).bitsPerSecond as number;
    expect(coldEstimate).toBeGreaterThan(warmEstimate);
    expect(warmEstimate).toBeCloseTo(100e6, 0);
  });
});

describe("estimateLatency", () => {
  function latency(overrides: Partial<LatencySample> = {}): LatencySample {
    return {
      timeToFirstByteMilliseconds: 50,
      handshakeMilliseconds: null,
      domainLookupMilliseconds: null,
      contended: false,
      at: NOW,
      source: "resource",
      ...overrides,
    };
  }

  it("returns nothing without samples", () => {
    expect(estimateLatency([], CONFIG, NOW).roundTripMilliseconds).toBeNull();
  });

  it("min-filters the round trip so server think time drops out", () => {
    const samples = [latency({ timeToFirstByteMilliseconds: 22 }), latency({ timeToFirstByteMilliseconds: 140 }), latency({ timeToFirstByteMilliseconds: 300 })];
    expect(estimateLatency(samples, CONFIG, NOW).roundTripMilliseconds).toBe(22);
  });

  it("prefers half a handshake when one was measured", () => {
    // A TCP+TLS handshake is about two round trips, so 30 ms of handshake
    // implies a 15 ms round trip even though every response took 90 ms.
    const samples = [latency({ timeToFirstByteMilliseconds: 90, handshakeMilliseconds: 30 }), latency({ timeToFirstByteMilliseconds: 95 })];
    expect(estimateLatency(samples, CONFIG, NOW).roundTripMilliseconds).toBe(15);
  });

  it("reports the median time to first byte and its deviation as jitter", () => {
    const samples = [40, 50, 60, 50, 50].map((timeToFirstByteMilliseconds) => latency({ timeToFirstByteMilliseconds }));
    const estimate = estimateLatency(samples, CONFIG, NOW);
    expect(estimate.timeToFirstByteMilliseconds).toBeCloseTo(50, 5);
    expect(estimate.jitterMilliseconds).toBeCloseTo(4, 5);
  });

  it("scores steady links above erratic ones", () => {
    const steady = Array.from({ length: 10 }, () => latency({ timeToFirstByteMilliseconds: 50 }));
    const erratic = [10, 400, 40, 900, 30, 600, 20, 800, 60, 500].map((timeToFirstByteMilliseconds) => latency({ timeToFirstByteMilliseconds }));
    expect(estimateLatency(steady, CONFIG, NOW).confidence.score).toBeGreaterThan(
      estimateLatency(erratic, CONFIG, NOW).confidence.score,
    );
  });
});

describe("jitter robustness", () => {
  function latency(timeToFirstByteMilliseconds: number): LatencySample {
    return { timeToFirstByteMilliseconds, handshakeMilliseconds: null, domainLookupMilliseconds: null, contended: false, at: NOW, source: "resource" };
  }

  it("is not blown up by one request that queued behind a big download", () => {
    const steady = [48, 50, 52, 49, 51, 50, 48, 52, 51, 49].map(latency);
    const withOutlier = [...steady, latency(4200)];
    const clean = estimateLatency(steady, CONFIG, NOW).jitterMilliseconds as number;
    const noisy = estimateLatency(withOutlier, CONFIG, NOW).jitterMilliseconds as number;
    expect(noisy).toBeLessThan(clean * 3);
    expect(noisy).toBeLessThan(20);
  });

  it("still reports real instability", () => {
    const erratic = [20, 120, 40, 160, 30, 140, 25, 150, 35, 130].map(latency);
    expect(estimateLatency(erratic, CONFIG, NOW).jitterMilliseconds as number).toBeGreaterThan(30);
  });

  it("keeps every sample when there are too few to trim", () => {
    const few = [40, 60, 900].map(latency);
    expect(estimateLatency(few, CONFIG, NOW).jitterMilliseconds as number).toBeGreaterThan(100);
  });
});

describe("contended latency samples", () => {
  function latency(timeToFirstByteMilliseconds: number, contended = false): LatencySample {
    return { timeToFirstByteMilliseconds, handshakeMilliseconds: null, domainLookupMilliseconds: null, contended, at: NOW, source: "resource" };
  }

  it("ignores requests that queued behind the page's own downloads", () => {
    const samples = [
      latency(40),
      latency(44),
      latency(42),
      latency(1500, true),
      latency(1700, true),
      latency(900, true),
    ];
    const estimate = estimateLatency(samples, CONFIG, NOW);
    expect(estimate.timeToFirstByteMilliseconds as number).toBeLessThan(60);
    expect(estimate.jitterMilliseconds as number).toBeLessThan(20);
  });

  it("falls back to contended samples, at reduced confidence, when that is all there is", () => {
    const contendedOnly = [latency(800, true), latency(1200, true), latency(1000, true)];
    const estimate = estimateLatency(contendedOnly, CONFIG, NOW);
    expect(estimate.roundTripMilliseconds).toBe(800);
    const quiet = [latency(800), latency(1200), latency(1000)];
    expect(estimate.confidence.score).toBeLessThan(
      estimateLatency(quiet, CONFIG, NOW).confidence.score,
    );
  });

  it("still uses contended samples for the round trip floor when they are faster", () => {
    // Queuing can only ever inflate a reading, so the minimum stays honest
    // across every sample, contended or not.
    const samples = [latency(90), latency(95), latency(88), latency(30, true)];
    expect(estimateLatency(samples, CONFIG, NOW).roundTripMilliseconds).toBe(30);
    // ...while the median and jitter still come from the quiet three.
    expect(estimateLatency(samples, CONFIG, NOW).timeToFirstByteMilliseconds as number).toBeGreaterThan(80);
  });
});

describe("burst allowance", () => {
  it("does not report a link's burst allowance as its speed", () => {
    // A link that hands out roughly 256 KB at line rate, then shapes to
    // 100 Mbps. Small transfers finish almost instantly and look enormous.
    const shapedBps = 100e6;
    const burstBytes = 256 * 1024;
    const shaped = (bytes: number) => {
      const overWire = Math.max(0, bytes - burstBytes);
      return Math.max(1, (overWire * 8 * 1000) / shapedBps + 2);
    };
    const samples = [
      sample({ bytes: 180_000, durationMilliseconds: shaped(180_000) }),
      sample({ bytes: 220_000, durationMilliseconds: shaped(220_000) }),
      sample({ bytes: 150_000, durationMilliseconds: shaped(150_000) }),
      sample({ bytes: 400_000, durationMilliseconds: shaped(400_000) }),
      // One transfer big enough that the allowance barely matters.
      sample({ bytes: 16_000_000, durationMilliseconds: shaped(16_000_000), concurrency: 4 }),
    ];
    const estimate = estimateDirection(samples, CONFIG, NOW);
    expect(estimate.megabitsPerSecond as number).toBeLessThan(110);
    expect(estimate.megabitsPerSecond as number).toBeGreaterThan(90);
  });

  it("keeps reaching for the top when every sample is small", () => {
    // With nothing large to anchor against, the cap cannot apply, and a fast
    // small transfer is still the best evidence available.
    const samples = [
      sample({ bytes: 100_000, durationMilliseconds: 40 }),
      sample({ bytes: 100_000, durationMilliseconds: 90 }),
      sample({ bytes: 100_000, durationMilliseconds: 120 }),
    ];
    expect(estimateDirection(samples, CONFIG, NOW).megabitsPerSecond as number).toBeGreaterThan(12);
  });
});

describe("averageBitsPerSecond", () => {
  function sample(bitsPerSecond: number, at = NOW): ThroughputSample {
    const bytes = 400_000;
    return {
      bytes,
      durationMilliseconds: (bytes * 8 * 1000) / bitsPerSecond,
      bitsPerSecond,
      concurrency: 1,
      resources: 1,
      freshFraction: 0,
      at,
      source: "resource",
    };
  }

  const config = {
    minimumSampleBytes: 32 * 1024,
    halfLifeMilliseconds: 24 * 60 * 60 * 1000,
    quantile: 0.9,
    slowStartCorrection: 1,
    roundTripMilliseconds: 20,
  };

  it("sits below the estimate, because the estimate reaches for the top", () => {
    // A spread of observations: most slow, one fast. The average follows the
    // bulk; the estimate follows the best, since no sample can overstate a link.
    const samples = [
      sample(10e6),
      sample(12e6),
      sample(11e6),
      sample(40e6),
    ];
    const estimate = estimateDirection(samples, config, NOW);

    expect(estimate.averageBitsPerSecond).not.toBeNull();
    expect(estimate.bitsPerSecond).not.toBeNull();
    expect(estimate.averageBitsPerSecond as number).toBeLessThan(estimate.bitsPerSecond as number);
    expect(estimate.averageBitsPerSecond as number).toBeGreaterThan(10e6);
    expect(estimate.averageBitsPerSecond as number).toBeLessThan(40e6);
  });

  it("is the mean, not the maximum", () => {
    const estimate = estimateDirection([sample(20e6), sample(60e6)], config, NOW);
    expect(estimate.peakBitsPerSecond).toBeCloseTo(60e6, -3);
    expect(estimate.averageBitsPerSecond as number).toBeLessThan(estimate.peakBitsPerSecond as number);
  });

  it("is null when nothing has been observed", () => {
    expect(estimateDirection([], config, NOW).averageBitsPerSecond).toBeNull();
  });
});
