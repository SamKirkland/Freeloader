import { describe, expect, it } from "vitest";
import { Freeloader } from "../src/freeloader.js";
import {
  createConnections,
  lightPage,
  mediaPage,
  simulatePageLoad,
  staggeredPage,
  typicalPage,
  type LinkProfile,
  type ResourceSpec,
} from "./helpers/simulate.js";

const PROFILES: Record<string, LinkProfile> = {
  "3g 5 Mbps": { capacityBps: 5e6, roundTripMilliseconds: 120, serverThinkMs: 25, maxConcurrent: 6, jitterMilliseconds: 12, seed: 7 },
  "dsl 25 Mbps": { capacityBps: 25e6, roundTripMilliseconds: 40, serverThinkMs: 15, maxConcurrent: 6, jitterMilliseconds: 6, seed: 11 },
  "cable 100 Mbps": { capacityBps: 100e6, roundTripMilliseconds: 20, serverThinkMs: 10, maxConcurrent: 6, jitterMilliseconds: 4, seed: 13 },
  "fibre 500 Mbps": { capacityBps: 500e6, roundTripMilliseconds: 8, serverThinkMs: 6, maxConcurrent: 6, jitterMilliseconds: 2, seed: 17 },
  "gigabit 1 Gbps": { capacityBps: 1e9, roundTripMilliseconds: 5, serverThinkMs: 4, maxConcurrent: 6, jitterMilliseconds: 1.5, seed: 19 },
};

const JOURNEY: (() => ResourceSpec[])[] = [
  typicalPage,
  mediaPage,
  lightPage,
  staggeredPage,
  typicalPage,
  mediaPage,
];

interface BrowseResult {
  freeloader: Freeloader;
  ratios: number[];
}

/**
 * Walk a simulated user through several pages on one link.
 *
 * The library's clock is pinned to the simulated one, so sample ageing behaves
 * exactly as it would over a real browsing session.
 */
function browse(profile: LinkProfile, journey = JOURNEY, options = {}): BrowseResult {
  let clock = 0;
  const freeloader = new Freeloader(
    {
      persist: false,
      instrumentUploads: false,
      now: () => clock,
      timeOrigin: 0,
      ...options,
    },
    null,
  );
  const pool = createConnections(profile);
  const ratios: number[] = [];

  for (let visit = 0; visit < journey.length; visit++) {
    const page = (journey[visit] as () => ResourceSpec[])();
    const entries = simulatePageLoad({ ...profile, seed: (profile.seed ?? 1) + visit }, page, clock, pool);
    for (const entry of entries) freeloader.ingest(entry);
    clock = Math.max(clock, ...entries.map((e) => e.responseEnd ?? 0)) + 3000;
    freeloader.flush(clock);
    ratios.push((freeloader.getEstimate().download.bitsPerSecond ?? 0) / profile.capacityBps);
  }
  return { freeloader, ratios };
}

describe("accuracy against a link of known capacity", () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    describe(name, () => {
      it("lands within 10% of true capacity after a short browsing session", () => {
        const { ratios } = browse(profile);
        const final = ratios[ratios.length - 1] as number;
        expect(final).toBeGreaterThan(0.9);
        expect(final).toBeLessThan(1.1);
      });

      it("never claims the link is faster than it is", () => {
        const { ratios } = browse(profile);
        // Passive measurement is a lower bound; a few percent of overshoot is
        // timer noise, anything more is a broken correction.
        for (const ratio of ratios) expect(ratio).toBeLessThan(1.05);
      });

      it("gets closer as the user browses more", () => {
        const { ratios } = browse(profile);
        const first = ratios[0] as number;
        const final = ratios[ratios.length - 1] as number;
        expect(Math.abs(1 - final)).toBeLessThanOrEqual(Math.abs(1 - first) + 0.02);
      });

      it("recovers the round trip and reports plausible jitter", () => {
        const { freeloader } = browse(profile);
        const { latency } = freeloader.getEstimate();
        expect(latency.roundTripMilliseconds).toBeGreaterThan(profile.roundTripMilliseconds * 0.8);
        expect(latency.roundTripMilliseconds).toBeLessThan(profile.roundTripMilliseconds * 1.25);
        // Jitter is drawn uniformly from +/-jitterMilliseconds, so its mean absolute
        // deviation should land near half the peak.
        expect(latency.jitterMilliseconds ?? 0).toBeGreaterThan(profile.jitterMilliseconds * 0.15);
        expect(latency.jitterMilliseconds ?? 0).toBeLessThan(profile.jitterMilliseconds * 0.9);
      });

      it("reports rising confidence as evidence accumulates", () => {
        let clock = 0;
        const freeloader = new Freeloader(
          { persist: false, instrumentUploads: false, now: () => clock, timeOrigin: 0 },
          null,
        );
        const pool = createConnections(profile);
        const scores: number[] = [];
        for (let visit = 0; visit < 4; visit++) {
          const entries = simulatePageLoad(
            { ...profile, seed: (profile.seed ?? 1) + visit },
            typicalPage(),
            clock,
            pool,
          );
          for (const entry of entries) freeloader.ingest(entry);
          clock = Math.max(clock, ...entries.map((e) => e.responseEnd ?? 0)) + 3000;
          freeloader.flush(clock);
          scores.push(freeloader.getEstimate().download.confidence.score);
        }
        expect(scores[3] as number).toBeGreaterThan(scores[0] as number);
        expect(scores[3] as number).toBeGreaterThan(0.6);
      });
    });
  }

  it("does not inflate warm connections that never paid a slow-start ramp", () => {
    const warm: LinkProfile = {
      capacityBps: 100e6,
      roundTripMilliseconds: 20,
      serverThinkMs: 10,
      maxConcurrent: 6,
      jitterMilliseconds: 4,
      seed: 23,
      noSlowStart: true,
    };
    const { ratios } = browse(warm);
    for (const ratio of ratios) expect(ratio).toBeLessThan(1.05);
    expect(ratios[ratios.length - 1] as number).toBeGreaterThan(0.9);
  });

  it("is honest on a light page: low confidence rather than a wrong number", () => {
    const profile = PROFILES["cable 100 Mbps"] as LinkProfile;
    const { freeloader } = browse(profile, [lightPage]);
    const { download } = freeloader.getEstimate();
    // A page of 30 KB assets cannot reveal a 100 Mbps link, and the library
    // should say so instead of guessing.
    expect(download.confidence.score).toBeLessThan(0.6);
  });

  it("finds the link by regression when assets arrive one at a time", () => {
    const profile = PROFILES["fibre 500 Mbps"] as LinkProfile;
    const { freeloader } = browse(profile, [staggeredPage, staggeredPage]);
    const { download } = freeloader.getEstimate();
    expect(download.regressionBitsPerSecond).not.toBeNull();
    expect((download.regressionBitsPerSecond as number) / profile.capacityBps).toBeGreaterThan(0.9);
    expect((download.regressionBitsPerSecond as number) / profile.capacityBps).toBeLessThan(1.1);
  });

  it("ignores cached and cross-origin-opaque entries entirely", () => {
    const profile = PROFILES["dsl 25 Mbps"] as LinkProfile;
    const freeloader = new Freeloader({ persist: false, instrumentUploads: false }, null);
    const entries = simulatePageLoad(profile, typicalPage(), 0);
    for (const entry of entries) freeloader.ingest(entry);
    freeloader.flush(1e6);
    const debug = freeloader.debug();
    expect(debug.skipped["cache-hit"]).toBe(1);
    // A cross-origin response without Timing-Allow-Origin is indistinguishable
    // from a cache hit by size alone: both report zero transferred bytes.
    expect(debug.skipped["no-transfer-size"]).toBe(1);
    // The 120 KB cached image must not be counted as bytes off the network.
    expect(debug.totals.downloadBytes).toBeLessThan(2_800_000);
  });

  it("tracks a link that gets slower without clinging to the old number", () => {
    const fast: LinkProfile = { capacityBps: 100e6, roundTripMilliseconds: 20, serverThinkMs: 10, maxConcurrent: 6, jitterMilliseconds: 4, seed: 3 };
    const slow: LinkProfile = { ...fast, capacityBps: 8e6, roundTripMilliseconds: 90, seed: 5 };

    let clock = 0;
    const freeloader = new Freeloader(
      {
        persist: false,
        instrumentUploads: false,
        halfLifeMilliseconds: 60_000,
        quantile: 0.75,
        now: () => clock,
        timeOrigin: 0,
      },
      null,
    );
    const pool = createConnections(fast);
    for (let visit = 0; visit < 3; visit++) {
      const entries = simulatePageLoad({ ...fast, seed: fast.seed! + visit }, typicalPage(), clock, pool);
      for (const entry of entries) freeloader.ingest(entry);
      clock = Math.max(clock, ...entries.map((e) => e.responseEnd ?? 0)) + 1000;
      freeloader.flush(clock);
    }
    expect((freeloader.getEstimate().download.megabitsPerSecond as number)).toBeGreaterThan(80);

    // The user moves to a slow network and keeps browsing.
    for (let visit = 0; visit < 8; visit++) {
      const entries = simulatePageLoad({ ...slow, seed: slow.seed! + visit }, typicalPage(), clock, pool);
      for (const entry of entries) freeloader.ingest(entry);
      clock = Math.max(clock, ...entries.map((e) => e.responseEnd ?? 0)) + 1000;
      freeloader.flush(clock);
    }
    expect(freeloader.getEstimate().download.megabitsPerSecond as number).toBeLessThan(20);
  });
});

describe("entries arriving the way a browser delivers them", () => {
  /**
   * A browser reports a transfer only when it finishes, and the observer fires
   * as each one lands. So a page's entries arrive in completion order, not in
   * start order, and measurement happens between them. A 12-second download
   * therefore shows up long after the short transfers it was sharing the link
   * with, and must still end up in the same burst as them.
   */
  function browseInCompletionOrder(profile: LinkProfile, journey = JOURNEY): number[] {
    let clock = 0;
    const freeloader = new Freeloader(
      { persist: false, instrumentUploads: false, now: () => clock, timeOrigin: 0 },
      null,
    );
    const pool = createConnections(profile);
    const ratios: number[] = [];

    for (let visit = 0; visit < journey.length; visit++) {
      const page = (journey[visit] as () => ResourceSpec[])();
      const entries = simulatePageLoad({ ...profile, seed: (profile.seed ?? 1) + visit }, page, clock, pool)
        .slice()
        .sort((a, b) => (a.responseEnd ?? 0) - (b.responseEnd ?? 0));

      for (const entry of entries) {
        freeloader.ingest(entry);
        // The observer callback fires here, and a flush follows it.
        clock = Math.max(clock, entry.responseEnd ?? 0) + 50;
        freeloader.flush(clock);
      }
      clock += 3000;
      freeloader.flush(clock);
      ratios.push((freeloader.getEstimate().download.bitsPerSecond ?? 0) / profile.capacityBps);
    }
    return ratios;
  }

  for (const [name, profile] of Object.entries(PROFILES)) {
    it(`still lands within 10% on ${name}`, () => {
      const ratios = browseInCompletionOrder(profile);
      const final = ratios[ratios.length - 1] as number;
      expect(final).toBeGreaterThan(0.9);
      expect(final).toBeLessThan(1.1);
    });
  }

  it("merges parallel images even though the biggest is reported last", () => {
    // Twelve images sharing a 20 Mbps link. Measured one by one they look like
    // 1-3 Mbps each; the burst they form is the truth.
    const profile: LinkProfile = {
      capacityBps: 20e6,
      roundTripMilliseconds: 60,
      serverThinkMs: 20,
      maxConcurrent: 6,
      jitterMilliseconds: 8,
      seed: 31,
    };
    const images: ResourceSpec[] = [
      { url: "https://example.test/page.html", bytes: 16_000 },
      ...[180_000, 270_000, 1_490_000, 1_490_000, 185_000, 420_000, 36_000, 2_200_000, 60_000, 1_000_000].map(
        (bytes, i) => ({ url: `https://example.test/img-${i}.jpg`, bytes, initiatorType: "img" }),
      ),
    ];
    const ratios = browseInCompletionOrder(profile, [() => images]);
    expect(ratios[0] as number).toBeGreaterThan(0.85);
    expect(ratios[0] as number).toBeLessThan(1.1);
  });
});
