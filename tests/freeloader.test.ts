import { describe, expect, it, vi } from "vitest";
import { Freeloader, type NetworkEstimate, type StorageLike } from "../src/freeloader.js";
import { createConnections, simulatePageLoad, typicalPage, type LinkProfile } from "./helpers/simulate.js";

class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const PROFILE: LinkProfile = {
  capacityBps: 50e6,
  roundTripMilliseconds: 30,
  serverThinkMs: 12,
  maxConcurrent: 6,
  jitterMilliseconds: 5,
  seed: 42,
};

/** Load one simulated page into a Freeloader instance and settle the bursts. */
function loadPage(freeloader: Freeloader, at: number, pool = createConnections(PROFILE)): number {
  const entries = simulatePageLoad({ ...PROFILE, seed: PROFILE.seed! + at }, typicalPage(), at, pool);
  for (const entry of entries) freeloader.ingest(entry);
  const end = Math.max(at, ...entries.map((e) => e.responseEnd ?? 0)) + 2000;
  freeloader.flush(end);
  return end;
}

describe("Freeloader lifecycle", () => {
  it("starts with an empty estimate and no crash outside a browser", () => {
    const freeloader = new Freeloader({ persist: false }, null);
    const estimate = freeloader.getEstimate();
    expect(estimate.download.bitsPerSecond).toBeNull();
    expect(estimate.upload.bitsPerSecond).toBeNull();
    expect(estimate.latency.roundTripMilliseconds).toBeNull();
  });

  it("start and stop are idempotent and survive a missing PerformanceObserver", () => {
    const freeloader = new Freeloader({ persist: false, instrumentUploads: false }, null);
    expect(() => {
      freeloader.start();
      freeloader.start();
      freeloader.stop();
      freeloader.stop();
    }).not.toThrow();
    expect(freeloader.isRunning).toBe(false);
  });

  it("un-patches fetch when stopped", () => {
    const original = globalThis.fetch;
    const freeloader = new Freeloader({ persist: false }, null);
    freeloader.start();
    expect(globalThis.fetch).not.toBe(original);
    freeloader.stop();
    expect(globalThis.fetch).toBe(original);
  });

  it("patches fetch once however many times start is called", () => {
    const original = globalThis.fetch;
    const freeloader = new Freeloader({ persist: false }, null);
    freeloader.start();
    const patched = globalThis.fetch;
    freeloader.start();
    freeloader.start();
    expect(globalThis.fetch).toBe(patched);
    freeloader.stop();
    expect(globalThis.fetch).toBe(original);
  });

  it("can be stopped and started again, and un-patches cleanly each time", () => {
    const original = globalThis.fetch;
    const freeloader = new Freeloader({ persist: false }, null);
    for (let i = 0; i < 3; i++) {
      freeloader.start();
      expect(freeloader.isRunning).toBe(true);
      expect(globalThis.fetch).not.toBe(original);
      freeloader.stop();
      expect(freeloader.isRunning).toBe(false);
      expect(globalThis.fetch).toBe(original);
    }
  });

  it("stop before start does nothing", () => {
    const original = globalThis.fetch;
    const freeloader = new Freeloader({ persist: false }, null);
    expect(() => freeloader.stop()).not.toThrow();
    expect(freeloader.isRunning).toBe(false);
    expect(globalThis.fetch).toBe(original);
  });

  it("keeps working after stop: reads, ingest, flush and reset do not throw", () => {
    const freeloader = new Freeloader({ persist: false }, null);
    freeloader.start();
    freeloader.stop();
    expect(() => {
      loadPage(freeloader, 0);
      freeloader.getEstimate();
      freeloader.debug();
      freeloader.reset();
    }).not.toThrow();
  });

  it("restores fetch whichever order two instances stop in", () => {
    const original = globalThis.fetch;
    const a = new Freeloader({ persist: false }, null);
    const b = new Freeloader({ persist: false }, null);
    a.start();
    b.start();
    b.stop();
    a.stop();
    expect(globalThis.fetch).toBe(original);
  });
});

describe("Freeloader restart", () => {
  /** A PerformanceObserver that replays a fixed buffer, as `buffered: true` does. */
  function installObserver(buffer: unknown[]): () => void {
    const host = globalThis as { PerformanceObserver?: unknown };
    const previous = host.PerformanceObserver;
    host.PerformanceObserver = class {
      constructor(private readonly callback: (list: { getEntries(): unknown[] }) => void) {}
      observe(options: { type: string; buffered?: boolean }): void {
        const entries = buffer.filter((e) => (e as { entryType: string }).entryType === options.type);
        if (options.buffered && entries.length > 0) this.callback({ getEntries: () => entries });
      }
      disconnect(): void {}
    };
    return () => {
      host.PerformanceObserver = previous;
    };
  }

  it("does not count the page's traffic twice when restarted", () => {
    const entries = simulatePageLoad(PROFILE, typicalPage(), 0, createConnections(PROFILE));
    const restore = installObserver(entries);
    try {
      const freeloader = new Freeloader({ persist: false, instrumentUploads: false }, null);
      freeloader.start();
      freeloader.flush(1e6);
      const bytes = freeloader.debug().totals.downloadBytes;
      const resources = freeloader.getEstimate().download.resources;
      expect(bytes).toBeGreaterThan(0);

      freeloader.stop();
      freeloader.start();
      freeloader.flush(2e6);
      expect(freeloader.debug().totals.downloadBytes).toBe(bytes);
      expect(freeloader.getEstimate().download.resources).toBe(resources);
      freeloader.stop();
    } finally {
      restore();
    }
  });

  it("does not bring old traffic back after reset and restart", () => {
    const entries = simulatePageLoad(PROFILE, typicalPage(), 0, createConnections(PROFILE));
    const restore = installObserver(entries);
    try {
      const freeloader = new Freeloader({ persist: false, instrumentUploads: false }, null);
      freeloader.start();
      freeloader.flush(1e6);
      freeloader.stop();
      freeloader.reset();
      freeloader.start();
      freeloader.flush(2e6);
      expect(freeloader.debug().totals.downloadBytes).toBe(0);
      freeloader.stop();
    } finally {
      restore();
    }
  });
});

describe("Freeloader observation", () => {
  it("builds an estimate from ordinary page traffic", () => {
    const freeloader = new Freeloader({ persist: false, instrumentUploads: false }, null);
    loadPage(freeloader, 0);
    const { download, latency } = freeloader.getEstimate();
    expect(download.megabitsPerSecond as number).toBeGreaterThan(40);
    expect(download.megabitsPerSecond as number).toBeLessThan(52);
    expect(latency.roundTripMilliseconds as number).toBeCloseTo(PROFILE.roundTripMilliseconds, 0);
  });

  it("counts every resource behind each estimate, including ones merged into a burst", () => {
    const freeloader = new Freeloader({ persist: false, instrumentUploads: false }, null);
    for (let i = 0; i < 4; i++) {
      freeloader.ingest({
        name: `https://example.com/image-${i}.jpg`,
        entryType: "resource",
        startTime: i * 5,
        duration: 400,
        requestStart: 10 + i * 5,
        responseStart: 40 + i * 5,
        responseEnd: 400 + i * 5,
        transferSize: 500_000,
        encodedBodySize: 499_700,
      });
    }
    freeloader.flush(2000);
    const { download, upload, latency } = freeloader.getEstimate();
    expect(download.confidence.samples).toBe(1);
    expect(download.resources).toBe(4);
    expect(upload.resources).toBe(0);
    expect(latency.resources).toBe(4);
  });

  it("notifies subscribers and the onUpdate hook when the estimate changes", () => {
    const seen: NetworkEstimate[] = [];
    const onUpdate = vi.fn();
    const freeloader = new Freeloader({ persist: false, instrumentUploads: false, onUpdate }, null);
    const unsubscribe = freeloader.subscribe((estimate) => seen.push(estimate));

    loadPage(freeloader, 0);
    expect(seen.length).toBeGreaterThan(0);
    expect(onUpdate).toHaveBeenCalled();

    const countAfterFirst = seen.length;
    unsubscribe();
    loadPage(freeloader, 60_000);
    expect(seen).toHaveLength(countAfterFirst);
  });

  it("keeps measuring even if a subscriber throws", () => {
    const freeloader = new Freeloader({ persist: false, instrumentUploads: false }, null);
    freeloader.subscribe(() => {
      throw new Error("subscriber is broken");
    });
    const good = vi.fn();
    freeloader.subscribe(good);
    expect(() => loadPage(freeloader, 0)).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  it("only observes the origins it was told to", () => {
    const freeloader = new Freeloader(
      { persist: false, instrumentUploads: false, origins: ["https://cdn.test"] },
      null,
    );
    const entries = simulatePageLoad(PROFILE, typicalPage("https://example.test/"), 0);
    for (const entry of entries) freeloader.ingest(entry);
    freeloader.flush(1e6);
    expect(freeloader.getEstimate().download.bitsPerSecond).toBeNull();
    expect(freeloader.debug().skipped["foreign-origin"]).toBe(entries.length);
  });

  it("exposes counters for debugging", () => {
    const freeloader = new Freeloader({ persist: false, instrumentUploads: false }, null);
    loadPage(freeloader, 0);
    const debug = freeloader.debug();
    expect(debug.downloadSamples + debug.liveDownloadSamples).toBeGreaterThan(0);
    expect(debug.latencySamples).toBeGreaterThan(0);
    expect(debug.totals.downloadBytes).toBeGreaterThan(1_000_000);
    expect(debug.lastSamples.length).toBeGreaterThan(0);
    expect(debug.lastUploadSamples).toEqual([]);
  });

  it("exposes recent upload samples for debugging", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(null, { status: 405 });
    }) as typeof fetch;
    const freeloader = new Freeloader({ persist: false }, null);
    try {
      freeloader.start();
      await fetch("/sink", { method: "POST", body: new Uint8Array(100_000) });
      const [sample] = freeloader.debug().lastUploadSamples;
      expect(sample?.source).toBe("fetch-upload");
      expect(sample?.bytes).toBe(100_000);
    } finally {
      freeloader.stop();
      globalThis.fetch = original;
    }
  });

  it("bounds how many samples it keeps while holding on to the best one", () => {
    const freeloader = new Freeloader(
      { persist: false, instrumentUploads: false, maximumSamples: 8, maximumLatencySamples: 10 },
      null,
    );
    let clock = 0;
    const pool = createConnections(PROFILE);
    for (let i = 0; i < 12; i++) clock = loadPage(freeloader, clock, pool);
    // Bursts stay open to revision for a while, so push the clock well past
    // that horizon to settle everything before checking the cap.
    freeloader.flush(clock + 10 * 60_000);

    const debug = freeloader.debug();
    expect(debug.liveDownloadSamples).toBe(0);
    expect(debug.downloadSamples).toBeLessThanOrEqual(8);
    expect(debug.latencySamples).toBeLessThanOrEqual(10);
    expect(freeloader.getEstimate().download.megabitsPerSecond as number).toBeGreaterThan(40);
  });
});

describe("Freeloader persistence", () => {
  it("restores what it learned in a previous page view", () => {
    const storage = new FakeStorage();
    const first = new Freeloader({ storageKey: "freeloader:test", instrumentUploads: false }, storage);
    loadPage(first, 0);
    const before = first.getEstimate().download.bitsPerSecond as number;
    expect(storage.map.has("freeloader:test")).toBe(true);

    // A new page in the same session: the estimate is there immediately,
    // before a single new byte has been observed.
    const second = new Freeloader({ storageKey: "freeloader:test", instrumentUploads: false }, storage);
    expect(second.getEstimate().download.bitsPerSecond as number).toBeCloseTo(before, 0);
    expect(second.debug().downloadSamples).toBeGreaterThan(0);
    expect(second.debug().liveDownloadSamples).toBe(0);
  });

  it("writes nothing when persistence is switched off", () => {
    const storage = new FakeStorage();
    const freeloader = new Freeloader({ persist: false, storageKey: "freeloader:test", instrumentUploads: false }, storage);
    loadPage(freeloader, 0);
    expect(storage.map.size).toBe(0);
  });

  it("forgets everything on reset, in memory and on disk", () => {
    const storage = new FakeStorage();
    const freeloader = new Freeloader({ storageKey: "freeloader:test", instrumentUploads: false }, storage);
    loadPage(freeloader, 0);
    freeloader.reset();
    expect(freeloader.getEstimate().download.bitsPerSecond).toBeNull();
    expect(freeloader.debug().downloadSamples).toBe(0);
    const restored = new Freeloader({ storageKey: "freeloader:test", instrumentUploads: false }, storage);
    expect(restored.getEstimate().download.bitsPerSecond).toBeNull();
  });

  it("does not mix estimates from two different sites' keys", () => {
    const storage = new FakeStorage();
    const a = new Freeloader({ storageKey: "np:a", instrumentUploads: false }, storage);
    loadPage(a, 0);
    const b = new Freeloader({ storageKey: "np:b", instrumentUploads: false }, storage);
    expect(b.getEstimate().download.bitsPerSecond).toBeNull();
  });
});

describe("Freeloader latency contention", () => {
  /** A transfer the browser reports once it finishes. */
  function transfer(name: string, requestStart: number, responseStart: number, responseEnd: number) {
    return {
      name: `https://example.test/${name}`,
      entryType: "resource",
      startTime: requestStart,
      duration: responseEnd - requestStart,
      transferSize: 400_000,
      requestStart,
      responseStart,
      responseEnd,
      connectStart: requestStart,
      connectEnd: requestStart,
    };
  }

  it("flags a request that waited while another transfer was running", () => {
    const freeloader = new Freeloader({ persist: false, instrumentUploads: false }, null);
    // A long download, reported when it ends at 2000 ms.
    freeloader.ingest(transfer("big.bin", 10, 50, 2000));
    // A request that waited from 100 to 1800 ms, all of it alongside that download.
    freeloader.ingest(transfer("slow.json", 100, 1800, 1900));
    freeloader.flush(3000);
    expect(freeloader.debug().contendedLatency).toBe(1);
  });

  it("flags samples retroactively when the competing transfer is reported later", () => {
    const freeloader = new Freeloader({ persist: false, instrumentUploads: false }, null);
    // The queued request finishes and is judged first: nothing else is known yet.
    freeloader.ingest(transfer("slow.json", 100, 1800, 1900));
    freeloader.flush(1950);
    expect(freeloader.debug().contendedLatency).toBe(0);

    // The download it was queued behind only now reports its timings.
    freeloader.ingest(transfer("big.bin", 10, 50, 2000));
    freeloader.flush(3000);
    expect(freeloader.debug().contendedLatency).toBe(1);
  });

  it("leaves a request that had the link to itself alone", () => {
    const freeloader = new Freeloader({ persist: false, instrumentUploads: false }, null);
    freeloader.ingest(transfer("first.bin", 10, 50, 500));
    freeloader.ingest(transfer("second.bin", 900, 950, 1400));
    freeloader.flush(2000);
    expect(freeloader.debug().contendedLatency).toBe(0);
    expect(freeloader.debug().latencySamples).toBe(2);
  });
});
